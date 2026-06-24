import { useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { otherParty } from "sui-tunnel-ts/protocol/Protocol";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import type { TelemetryWriter } from "../../telemetry/TelemetryProvider";
import {
  closeCooperativeWithRoot,
  openAndFundSelfPlay,
  readCreatedAt,
} from "../../onchain/tunnelTx";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { settleViaBackend } from "../../backend/settle";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "../../backend/controlPlane";
import { withSponsorFallback } from "../../onchain/sponsor";
import { useSponsoredSignExec } from "../../onchain/useSponsoredSignExec";
import {
  DOPAMINT_COIN_TYPE,
  isDopamintAddressBalance,
  isDopamintConfigured,
} from "../../onchain/dopamint";
import { type BattleshipMove } from "./protocol/battleship";
import {
  MultiGameBattleshipProtocol,
  type MultiGameBattleshipMove,
  type MultiGameBattleshipState,
} from "./protocol/multiGameBattleship";
import { deriveBattleshipView, type BattleshipView } from "./view";
import {
  type Placement,
  placeFleetRandom,
  placementsToBoard,
} from "./engine/fleet";
import { randomSalts } from "./engine/merkle";
import {
  type FleetSecret,
  makeFleetSecret,
  nextMove,
  randomFleetSecret,
} from "./engine/selfPlay";
import { type BotDifficulty } from "./engine/bot";

/** DOPAMINT stake locked per seat (1 DOPAMINT, 9 decimals). */
const LOCKED_PER_SEAT = 1_000_000_000n;
/** SUI-fallback stake per seat (MIST), when the DOPAMINT env is unset. */
const SUI_PER_SEAT = 500n;
const STAKE = 100n;
// Throughput, not per-move pacing: the driver applies moves in a synchronous batch
// and only renders + yields to the UI once per ~frame. This uncaps TPS from both the
// setTimeout(0) clamp (~4ms/move) and the per-move React re-render of the boards,
// while still repainting ~once a frame. 8ms ≈ half a 16ms frame, so the UI stays
// responsive between yields.
const FRAME_BUDGET_MS = 8;
/** The single bot skill — difficulty modes (easy/normal/hard) were dropped in favour
 *  of one mode; this is the smartest profile (probability-density targeting). */
const BOT_SKILL: BotDifficulty = "hard";

// Transcript-size cap (avoids a 413 at settle). The eventual /settle POST ships one
// ~0.55 KB entry per co-signed move, and the backend rejects bodies over 16 MB. During
// autopilot we therefore settle the current tunnel and open a fresh one after this many
// games — or this many entries, whichever comes first — so any single settle stays well
// under the limit. At "hard", a game is ~160 entries (≤~224 on long ones): 100 games ≈
// 8.8 MB typical / ≤~12 MB worst, and 24k entries ≈ 13 MB is the hard byte ceiling.
const ROLLOVER_GAMES = 100;
const ROLLOVER_ENTRIES = 24_000;

export type BattleshipStatus =
  | "idle"
  | "placing"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface BattleshipSession {
  status: BattleshipStatus;
  view: BattleshipView | null;
  error: string | null;
  /** Enter fleet placement. */
  playBot: () => void;
  /** Open + fund ONE tunnel and start the first game on it. */
  startBattle: (placements: Placement[]) => void;
  /** Fire at an enemy cell (only legal on your turn). */
  fire: (cell: number) => void;
  /** First-open default: auto-place a fleet, open the tunnel, and start playing with
   *  autopilot ON — instant action. Idempotent (a remount won't re-trigger). */
  autoStartOnLoad: () => void;
  /** True while autopilot also fires YOUR shots; with it on, finished games rematch
   *  automatically on the SAME tunnel until you settle. ON by default. */
  auto: boolean;
  /** Toggle autopilot for your seat; flipping it on resumes firing / auto-rematch. */
  setAuto: (on: boolean) => void;
  /** Arcade-cabinet hover-pause: freeze / unfreeze the auto loop in place. */
  pause: () => void;
  resume: () => void;
  /** Wins this session (one tunnel, many games): `you` = your wins, `foe` = bot wins. */
  score: { you: number; foe: number };
  /** Completed games behind the current one (the running game is `gamesPlayed + 1`). */
  gamesPlayed: number;
  /** Start the next game on the SAME tunnel with a freshly placed fleet (manual rematch). */
  playNextGame: (placements: Placement[]) => void;
  /** Settle + close the tunnel NOW at the current co-signed state — allowed anytime,
   *  even mid-game (mid-game pays out the net of finished games). Stops the loop. */
  settleNow: () => void;
  reset: () => void;
}

/** React-supplied capabilities, refreshed each render (wallet may connect later). */
interface BotDeps {
  report: TelemetryWriter;
  account: { address: string } | null;
  client: unknown;
  signExec: (tx: never) => Promise<{ digest: string }>;
  /** Backend-gas-sponsored signer (ADR-0009); falls back to signExec when the sponsor is down. */
  sponsoredSignExec: (tx: never) => Promise<{ digest: string }>;
  /** Pick a user coin to fund the (both-seat) stake; gas is sponsored, the stake is not. */
  selectStakeCoin: (minAmount: bigint) => Promise<string>;
  /** DOPAMINT stake: faucet (invisibly, sponsored) if short, then return a stake coin id. */
  prepareStake: (minAmount: bigint) => Promise<string>;
  /** ADR-0013: ensure the player's DOPAMINT address balance covers the stake (for the
   *  address-balance open path). No-op once topped up. */
  ensureStakeBalance: (minAmount: bigint) => Promise<void>;
}

interface BotSnapshot {
  status: BattleshipStatus;
  view: BattleshipView | null;
  error: string | null;
  auto: boolean;
  score: { you: number; foe: number };
  gamesPlayed: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The bot game's whole session, kept OUT of React so it survives the window
 * unmounting (minimize / maximize / desktop reflow). The component subscribes to
 * it; only an explicit window close disposes it. See `lib/windowSessions`.
 */
class BotSession {
  deps: BotDeps | null = null;

  private status: BattleshipStatus = "idle";
  private view: BattleshipView | null = null;
  private error: string | null = null;
  // Autopilot: when on, the driver fires YOUR shots too, so the whole match plays
  // itself. ON by default — opening the game drops you straight into the action
  // (toggle off to take manual control). Lives on the session, not React, because
  // the off-React advance loop reads it each step.
  private auto = true;
  private snap: BotSnapshot = {
    status: "idle",
    view: null,
    error: null,
    auto: true,
    score: { you: 0, foe: 0 },
    gamesPlayed: 0,
  };
  private listeners = new Set<() => void>();

  private tunnel: OffchainTunnel<
    MultiGameBattleshipState,
    MultiGameBattleshipMove
  > | null = null;
  private protocol: MultiGameBattleshipProtocol | null = null;
  private secrets: { A: FleetSecret; B: FleetSecret } | null = null;
  // One tunnel hosts many games; settlement is player-driven. `settleRequested`
  // stops the auto-rematch loop, `score`/`lastScoredGames` track the running tally.
  private settleRequested = false;
  private score = { you: 0, foe: 0 };
  private lastScoredGames = -1;
  // Finished games on the CURRENT tunnel — drives the periodic rollover (see ROLLOVER_GAMES).
  // Reset whenever a fresh tunnel opens; `gamesCompletedSession` keeps the cross-tunnel total.
  private gamesThisTunnel = 0;
  // Finished games across every tunnel this session — what the UI shows, so the count stays
  // monotonic through a rollover (which resets the tunnel's own gamesPlayed back to 0).
  private gamesCompletedSession = 0;
  private placements: Placement[] = []; // your fleet layout, for ship-status display
  private tunnelId = "";
  private createdAt = 0n;
  private transcript: Transcript | null = null;
  private onChain = false;
  private advancing = false;
  // Guards re-entry: a session that has begun a match can't be restarted (only
  // reset()/Play Again returns it to idle). Stops StrictMode / double-click dupes.
  private starting = false;
  private txnId = 0;
  private lastYourShot: number | null = null;
  private lastEnemyShot: number | null = null;
  // First-open auto-start guard: set once so a remount doesn't re-open a tunnel.
  private didAutoStart = false;
  // Hover-pause latch (shared arcade-cabinet shell): when set, the auto loop freezes
  // in place at the next frame; `resume()` restarts it. A fresh game clears it.
  private paused = false;
  // Bumped on reset/dispose so an in-flight bot loop knows to abandon ship.
  private gen = 0;
  // Control-plane TPS heartbeat (ADR-0002, self-play contract). The backend derives
  // live TPS from action COUNTS we send — never a rate. Registered once per match;
  // each co-signed update bumps `actions`/`moveCount`, flushed as a throttled window.
  private session: RegisterSessionResult | null = null;
  private moveCount = 0;
  private actions = 0;
  private lastHeartbeat = 0;
  // Local-telemetry counters accumulated per move, pushed to React once per frame
  // (see `flushCounters`) so the hot loop never pays a setState per move.
  private pending = { updates: 0, signatures: 0, verifications: 0, bytes: 0 };

  /** Push the frame's accumulated counters to the telemetry rail in one update. */
  private flushCounters() {
    if (this.pending.updates === 0) return;
    this.deps?.report.bumpCounters(this.pending);
    this.pending = { updates: 0, signatures: 0, verifications: 0, bytes: 0 };
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): BotSnapshot => this.snap;

  private emit() {
    this.snap = {
      status: this.status,
      view: this.view,
      error: this.error,
      auto: this.auto,
      score: this.score,
      gamesPlayed: this.gamesCompletedSession,
    };
    for (const l of this.listeners) l();
  }
  private setStatus(s: BattleshipStatus) {
    this.status = s;
    this.emit();
  }
  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }
  private pushView() {
    if (this.tunnel && this.secrets) {
      // The view is per single game — project from the current inner game state.
      this.view = deriveBattleshipView(
        this.tunnel.state.inner,
        this.placements,
        "A",
        {
          lastYourShot: this.lastYourShot,
          lastEnemyShot: this.lastEnemyShot,
          onChain: this.onChain,
        },
      );
    }
    this.emit();
  }

  playBot = () => {
    this.gen += 1;
    this.error = null;
    this.view = null;
    this.setStatus("placing");
  };

  reset = () => {
    this.gen += 1;
    this.advancing = false;
    this.starting = false;
    this.settleRequested = false;
    this.paused = false;
    this.didAutoStart = false; // a fresh entry/new-session re-arms the auto-start
    this.tunnel = null;
    this.protocol = null;
    this.transcript = null;
    this.secrets = null;
    this.session = null;
    this.score = { you: 0, foe: 0 };
    this.lastScoredGames = -1;
    this.gamesThisTunnel = 0;
    this.gamesCompletedSession = 0;
    this.lastYourShot = null;
    this.lastEnemyShot = null;
    this.deps?.report.setActive(0);
    this.status = "idle";
    this.view = null;
    this.error = null;
    this.emit();
  };

  dispose = () => {
    this.gen += 1;
    this.advancing = false;
    this.deps?.report.setActive(0);
    this.tunnel = null;
    this.transcript = null;
    this.secrets = null;
    this.session = null;
    this.listeners.clear();
  };

  /**
   * Throttled control-plane heartbeat (ADR-0002, self-play TPS contract). Sends the
   * action COUNT accumulated since the last flush — never a rate; the backend is the
   * single clock and derives TPS from the counts. Self-throttles to ~1/s unless
   * `force` (the tail flush at settle, so the final partial window isn't dropped).
   */
  private flushHeartbeat(force: boolean) {
    const s = this.session;
    if (!s || this.actions === 0) return;
    const now = Date.now();
    const windowMs = now - this.lastHeartbeat;
    if (!force && windowMs < 1000) return;
    const actionsDelta = this.actions;
    this.actions = 0;
    this.lastHeartbeat = now;
    getControlPlaneClient()
      .sendHeartbeat(s.sessionId, s.statsToken, {
        tunnelId: this.tunnelId,
        nonce: String(this.moveCount),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => console.error("[battleship bot] heartbeat failed:", e));
  }

  private reportShotTxn(
    move: Extract<BattleshipMove, { type: "reveal" }>,
    defender: "A" | "B",
  ) {
    const youFired = otherParty(defender) === "A";
    this.deps?.report.pushTxn({
      id: (this.txnId += 1),
      game: "battleship",
      time: new Date().toLocaleTimeString("en-GB"),
      bot: youFired ? "You" : "Foe Bot",
      type: move.isShip ? (youFired ? "Hit" : "Hit taken") : "Miss",
      status: "Success",
      amount: move.isShip
        ? `${youFired ? "+" : "-"}$${Number(STAKE)}.00`
        : "$0.00",
    });
  }

  private settle = async () => {
    const tunnel = this.tunnel;
    if (!tunnel) return;
    this.setStatus("settling");
    // Tail flush before the close so the final partial window's actions aren't dropped.
    this.flushHeartbeat(true);
    this.deps?.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
    this.deps?.report.setActive(0);
    if (!this.onChain || !this.deps) {
      this.setStatus("settled"); // safety: no open tunnel to close (shouldn't happen post-start)
      return;
    }
    try {
      await this.closeTunnel(
        tunnel,
        this.transcript,
        this.tunnelId,
        this.createdAt,
      );
      this.setStatus("settled");
    } catch (e) {
      this.fail(e);
    }
  };

  /** Build the co-signed root settlement for `tunnel` and close it through the backend
   *  /settle API — the server submits the on-chain close AND archives the transcript to
   *  Walrus (ADR-0002/0005), with a sponsored/wallet close fallback if the backend is down.
   *  Pure money-path: no status/React side effects, so both the player-driven settle and the
   *  periodic rollover reuse it and each decide how a close affects the session. Needs
   *  `this.deps` (callers guard `onChain` separately). */
  private closeTunnel = async (
    tunnel: OffchainTunnel<MultiGameBattleshipState, MultiGameBattleshipMove>,
    transcript: Transcript | null,
    tunnelId: string,
    createdAt: bigint,
  ): Promise<void> => {
    const deps = this.deps;
    if (!deps) return;
    const settlement = tunnel.buildSettlementWithRoot(
      createdAt,
      transcript ? transcript.root() : new Uint8Array(32),
      0n,
    );
    const coinType = isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined;
    // DOPAMINT path closes via the gas sponsor too (so a 0-SUI player can close their bot
    // game for free); SUI path closes sender-pays. coinType must match the tunnel's coin.
    await settleViaBackend({
      tunnelId,
      settlement,
      transcript: transcript ? transcript.toRecord().entries : [],
      label: "battleship",
      fallbackClose: () =>
        closeCooperativeWithRoot({
          signExec: (isDopamintConfigured
            ? deps.sponsoredSignExec
            : deps.signExec) as never,
          tunnelId,
          settlement,
          coinType,
        }),
    });
  };

  /** Record the just-finished inner game's winner into the running tally, once. The
   *  finished game is uniquely keyed by `gamesPlayed` (bumped only at the next start). */
  private recordGameResult() {
    const tunnel = this.tunnel;
    if (!tunnel) return;
    const game = tunnel.state.gamesPlayed;
    if (game === this.lastScoredGames) return;
    const winner = tunnel.state.inner.winner;
    if (winner === 0) return;
    this.lastScoredGames = game;
    // Count finished games once here (the dedup above makes this idempotent, so a
    // pause/resume landing on a game-over state can't double-count). `gamesThisTunnel`
    // drives the rollover; `gamesCompletedSession` is the cross-tunnel total the UI shows.
    this.gamesThisTunnel += 1;
    this.gamesCompletedSession += 1;
    const iWon = winner === 1; // seat A is "you"
    if (iWon) this.score = { ...this.score, you: this.score.you + 1 };
    else this.score = { ...this.score, foe: this.score.foe + 1 };
    // One "My Activity" row per finished game (per match).
    this.deps?.report.pushLocalTxn({
      id: (this.txnId += 1),
      game: "battleship",
      time: new Date().toLocaleTimeString("en-GB"),
      bot: "You",
      type: iWon ? "Bot Win" : "Bot Loss",
      status: "Success",
      amount: "",
    });
  }

  /** Fresh fleets + placement for the next game on the same tunnel (auto rematch). */
  private makeMatchSecrets(): {
    secrets: { A: FleetSecret; B: FleetSecret };
    placements: Placement[];
  } {
    const placements = placeFleetRandom(Math.random);
    const human = makeFleetSecret(placementsToBoard(placements), randomSalts());
    const bot = randomFleetSecret(Math.random);
    return { secrets: { A: human, B: bot }, placements };
  }

  /**
   * Drive every automatic move (bot commit, all reveals, bot shots) until the human's
   * shot. Across game boundaries: when a game ends, record the result and EITHER loop
   * into the next game on the same tunnel (autopilot on, fundable, no settle pending)
   * OR stop and leave the result on screen for the player. Settlement is never
   * automatic — the player calls {@link settleNow}.
   */
  private advance = async () => {
    if (this.advancing) return;
    this.advancing = true;
    const myGen = this.gen;
    const tunnel = this.tunnel;
    const protocol = this.protocol;
    try {
      // Render + yield once per frame budget (not per move). Within a budget, moves
      // run synchronously back-to-back so TPS isn't throttled by setTimeout or React.
      let frameDeadline = Date.now() + FRAME_BUDGET_MS;
      while (tunnel && protocol && this.secrets) {
        const inner = tunnel.state.inner;
        if (inner.winner !== 0) {
          // A game finished. Tally it once, then decide: loop, roll over, or stop.
          this.recordGameResult();
          const sessionDone = protocol.isTerminal(tunnel.state); // funds exhausted
          if (!this.auto || this.settleRequested || sessionDone) break;
          // Transcript-size cap: once this tunnel has hosted enough games/entries, settle it
          // and continue on a fresh tunnel so the eventual /settle never 413s. rolloverTunnel
          // bumps `gen` and restarts advance() on the new tunnel, so bail out of this loop.
          if (
            this.gamesThisTunnel >= ROLLOVER_GAMES ||
            this.moveCount >= ROLLOVER_ENTRIES
          ) {
            void this.rolloverTunnel();
            return;
          }
          // Auto rematch on the SAME tunnel: fresh fleets, A's commit resets the board.
          const next = this.makeMatchSecrets();
          this.secrets = next.secrets;
          this.placements = next.placements;
          this.lastYourShot = null;
          this.lastEnemyShot = null;
          tunnel.step(
            { type: "commit", root: next.secrets.A.commitment.root },
            "A",
          );
        } else {
          const driven = nextMove(inner, this.secrets, Math.random, BOT_SKILL);
          if (!driven) break;
          // Human's shot: stop and wait for fire() — unless autopilot drives it too.
          if (driven.by === "A" && driven.move.type === "shoot" && !this.auto)
            break;
          if (driven.move.type === "shoot") {
            if (driven.by === "A") this.lastYourShot = driven.move.cell;
            else this.lastEnemyShot = driven.move.cell;
          }
          tunnel.step(driven.move, driven.by);
          // Per-shot rows flood the feed (and re-render it) at autopilot speed — only
          // log them in MANUAL play, where you can actually read them.
          if (driven.move.type === "reveal" && !this.auto)
            this.reportShotTxn(driven.move, driven.by);
        }
        // End of frame: flush the batched counters, paint the latest state once, then
        // yield so the UI can repaint / process input. A synchronous batch never blocks
        // longer than FRAME_BUDGET_MS.
        if (Date.now() >= frameDeadline) {
          this.flushCounters();
          this.pushView();
          await sleep(0);
          if (this.gen !== myGen || this.tunnel !== tunnel) return; // reset/disposed
          if (this.paused) return; // hover-pause: freeze here; resume() restarts the loop
          frameDeadline = Date.now() + FRAME_BUDGET_MS;
        }
      }
      this.flushCounters();
      this.pushView(); // final state always renders (game over / human's turn)
    } catch (e) {
      this.fail(e);
    } finally {
      this.advancing = false;
    }
  };

  startBattle = (placements: Placement[]) => {
    const deps = this.deps;
    if (!deps) return;
    // Bot play is on-chain only: a connected wallet funds + settles the self-play
    // tunnel (gas sponsored, DOPAMINT stake). No wallet → require connect, not a demo.
    if (!deps.account) {
      this.error = "connect a wallet to play";
      this.status = "error";
      this.emit();
      return;
    }
    // Only a fresh/placing session may start; a live game never restarts itself.
    if (this.starting || (this.status !== "idle" && this.status !== "placing"))
      return;
    this.starting = true;
    this.gen += 1;
    this.error = null;
    this.txnId = 0;
    this.settleRequested = false;
    this.paused = false; // a fresh game never inherits a stale hover-pause
    this.score = { you: 0, foe: 0 };
    this.lastScoredGames = -1;
    this.gamesCompletedSession = 0;
    this.lastYourShot = null;
    this.lastEnemyShot = null;

    this.placements = placements;
    const human = makeFleetSecret(placementsToBoard(placements), randomSalts());
    const bot = randomFleetSecret(Math.random);
    this.secrets = { A: human, B: bot };

    // Multi-game: one funded tunnel hosts many games; the player settles once (or the
    // autopilot rolls to a fresh tunnel every ROLLOVER_GAMES — see rolloverTunnel).
    this.protocol = new MultiGameBattleshipProtocol(STAKE);

    void (async () => {
      try {
        await this.openFundedTunnel();
        this.starting = false;
        this.setStatus("playing");
        this.pushView();
        void this.advance(); // commit A, commit B, then hand the turn to the human
      } catch (e) {
        this.starting = false;
        this.fail(e);
      }
    })();
  };

  /** Open + fund a fresh self-play tunnel on the current protocol and wire its transcript,
   *  leaving it ready for `advance()` to drive. Shared by the initial start and the periodic
   *  rollover. Mints new seat keys, sets this.tunnel/transcript/tunnelId/createdAt, and resets
   *  the per-tunnel nonce (`moveCount`) + game counter; it does NOT touch `score`, `auto`,
   *  `starting`, or `gamesCompletedSession`, and does NOT kick the loop — the caller owns those. */
  private openFundedTunnel = async (): Promise<void> => {
    const deps = this.deps;
    const protocol = this.protocol;
    if (!deps || !protocol)
      throw new Error("battleship: openFundedTunnel without deps/protocol");

    const a = createParticipant("you-seat");
    const b = createParticipant("foe-seat");
    // Per-path stake: 1 DOPAMINT vs a tiny MIST amount on the SUI fallback (so the fallback
    // doesn't lock real SUI). The same value funds on-chain AND inits the off-chain tunnel.
    const stakePerSeat = isDopamintConfigured ? LOCKED_PER_SEAT : SUI_PER_SEAT;

    const reads = deps.client as unknown as Parameters<
      typeof openAndFundSelfPlay
    >[0]["reads"];
    this.setStatus("funding");
    const partyA = { address: a.address, publicKey: a.keyPair.publicKey };
    const partyB = { address: b.address, publicKey: b.keyPair.publicKey };
    // DOPAMINT (ADR-0010): faucet both seats' stake invisibly (gas-sponsored) and stake
    // DOPAMINT — free for a 0-SUI player. SUI path (DOPAMINT env unset): sponsored SUI stake
    // with a sender-pays fallback (ADR-0009).
    // ADR-0013: with the address-balance path on, top up the player's DOPAMINT address balance
    // first; the open then withdraws from it instead of a version-pinned coin, so concurrent
    // reload-opens never equivocate. No-op once the balance is funded.
    if (isDopamintAddressBalance) {
      await deps.ensureStakeBalance(2n * stakePerSeat);
    }
    const tunnelId = isDopamintConfigured
      ? await openAndFundSelfPlay({
          reads,
          signExec: deps.sponsoredSignExec as never,
          partyA,
          partyB,
          aAmount: stakePerSeat,
          bAmount: stakePerSeat,
          coinType: DOPAMINT_COIN_TYPE,
          ...(isDopamintAddressBalance
            ? {
                stakeFromBalance: {
                  amount: 2n * stakePerSeat,
                  coinType: DOPAMINT_COIN_TYPE,
                },
              }
            : { stakeCoinId: await deps.prepareStake(2n * stakePerSeat) }),
        })
      : await withSponsorFallback(
          async () =>
            openAndFundSelfPlay({
              reads,
              signExec: deps.sponsoredSignExec as never,
              partyA,
              partyB,
              aAmount: stakePerSeat,
              bAmount: stakePerSeat,
              stakeCoinId: await deps.selectStakeCoin(2n * stakePerSeat),
            }),
          () =>
            openAndFundSelfPlay({
              reads,
              signExec: deps.signExec as never,
              partyA,
              partyB,
              aAmount: stakePerSeat,
              bAmount: stakePerSeat,
            }),
          "battleship bot open/fund",
        );
    const createdAt = await readCreatedAt(reads, tunnelId);

    const tunnel = OffchainTunnel.selfPlay(
      protocol,
      tunnelId,
      a.keyPair,
      b.keyPair,
      a.address,
      b.address,
      { a: stakePerSeat, b: stakePerSeat },
    );
    // Record every co-signed update so the close can anchor the transcript root on-chain
    // (close_cooperative_with_root) — the same settle path caro/poker/auto use successfully.
    const transcript = new Transcript(tunnelId);
    tunnel.onUpdate = (u, bytes) => {
      transcript.append(u);
      // One co-signed update = one action for the control-plane TPS count (ADR-0002);
      // moveCount is the monotonic nonce.
      this.moveCount += 1;
      this.actions += 1;
      // Accumulate the local-telemetry counters here but DON'T touch React per move
      // — `flushCounters()` pushes the whole frame's delta once, so the hot loop isn't
      // throttled by a setState (the dominant per-move cost at high TPS).
      this.pending.updates += 1;
      this.pending.signatures += 2;
      this.pending.verifications += 2;
      this.pending.bytes += bytes;
      this.flushHeartbeat(false);
    };

    this.tunnel = tunnel;
    this.transcript = transcript;
    this.tunnelId = tunnelId;
    this.createdAt = createdAt;
    this.onChain = true;

    // Register the on-chain tunnel for control-plane TPS stats (ADR-0002). Best-effort:
    // the backend is never in the per-move loop, so a failed register must not block play.
    this.session = null;
    this.moveCount = 0;
    this.actions = 0;
    this.gamesThisTunnel = 0;
    this.lastScoredGames = -1; // dedup key is per-tunnel — gamesPlayed restarts at 0
    this.lastHeartbeat = Date.now();
    getControlPlaneClient()
      .registerSession({
        userAddress: a.address,
        game: "battleship",
        tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
      })
      .then((s) => {
        this.session = s;
      })
      .catch((e) =>
        console.error("[battleship bot] registerSession failed:", e),
      );

    this.deps?.report.bumpCounters({ tunnelsOpened: 1 });
    this.deps?.report.setActive(2);
  };

  /** Periodic transcript-size cap (ADR-0002 §settle): during autopilot, after ROLLOVER_GAMES
   *  (or ROLLOVER_ENTRIES) on one tunnel, settle it and open a fresh one so any single /settle
   *  payload stays well under the backend's 16 MB body limit. The old tunnel is self-contained
   *  once its co-signed settlement + transcript are final, so we close it in the BACKGROUND and
   *  start the next tunnel without waiting on the on-chain close. Score + gamesCompletedSession
   *  carry across; only the transcript (and per-tunnel counters) reset. */
  private rolloverTunnel = async () => {
    const oldTunnel = this.tunnel;
    const oldTranscript = this.transcript;
    const oldTunnelId = this.tunnelId;
    const oldCreatedAt = this.createdAt;
    if (!oldTunnel || !this.deps || !this.protocol || !this.onChain) return;
    this.gen += 1; // abandon the old loop (mirrors settleNow/playNextGame)
    this.advancing = false;
    // Background-close the just-finished tunnel. Failures fall back to a wallet close inside
    // closeTunnel; if even that fails the stake stays locked, so log loudly but never abort the
    // session — the next tunnel is already taking over.
    this.deps.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
    void this.closeTunnel(
      oldTunnel,
      oldTranscript,
      oldTunnelId,
      oldCreatedAt,
    ).catch((e) =>
      console.error(
        "[battleship bot] rollover close failed; stake may stay locked:",
        e,
      ),
    );
    try {
      await this.openFundedTunnel();
      this.setStatus("playing");
      this.pushView();
      void this.advance();
    } catch (e) {
      this.fail(e);
    }
  };

  /** First-open default: drop straight into the action. Auto-place a random fleet,
   *  open the tunnel, and start playing (autopilot is already on). Guarded so a
   *  remount or a re-render can't re-open a second tunnel. */
  autoStartOnLoad = () => {
    if (this.didAutoStart || this.status !== "idle") return;
    if (!this.deps?.account) return; // wallet not ready yet; the effect retries
    this.didAutoStart = true;
    this.startBattle(placeFleetRandom(Math.random));
  };

  /** Hover-pause (arcade-cabinet shell): freeze the auto loop in place. The running
   *  advance() returns at its next frame; no-op if nothing is auto-playing. */
  pause = () => {
    this.paused = true;
  };

  /** Resume after a hover that didn't take the seat — restart the frozen loop. */
  resume = () => {
    if (!this.paused) return;
    this.paused = false;
    if (this.status === "playing") void this.advance();
  };

  setAuto = (on: boolean) => {
    if (this.auto === on) return;
    this.auto = on;
    this.emit();
    // Turning autopilot on while a game is idle (your turn, or a finished game waiting
    // to rematch): kick the driver so it fires / loops into the next game.
    if (on && this.status === "playing") void this.advance();
  };

  /** Manual rematch: start the next game on the SAME tunnel with a freshly placed
   *  fleet. Only valid between games (current game over) and while fundable. */
  playNextGame = (placements: Placement[]) => {
    const tunnel = this.tunnel;
    if (!tunnel || this.status !== "playing") return;
    if (tunnel.state.inner.winner === 0) return; // a game is still in progress
    if (this.protocol?.isTerminal(tunnel.state)) return; // funds exhausted — settle
    this.gen += 1; // abandon any stale loop; a fresh advance() drives the new game
    this.advancing = false;
    this.placements = placements;
    const human = makeFleetSecret(placementsToBoard(placements), randomSalts());
    const bot = randomFleetSecret(Math.random);
    this.secrets = { A: human, B: bot };
    this.lastYourShot = null;
    this.lastEnemyShot = null;
    try {
      tunnel.step({ type: "commit", root: human.commitment.root }, "A");
      this.pushView();
      void this.advance();
    } catch (e) {
      this.fail(e);
    }
  };

  /** Close the tunnel NOW at the current co-signed state — allowed anytime, even
   *  mid-game (which pays out the net of finished games and voids the running one).
   *  Stops the autopilot loop first so nothing steps while the close is built. */
  settleNow = () => {
    if (this.status !== "playing") return;
    this.settleRequested = true;
    this.gen += 1; // make the in-flight advance loop bail before its next step
    this.advancing = false;
    void this.settle();
  };

  fire = (cell: number) => {
    const tunnel = this.tunnel;
    if (!tunnel) return;
    // Autopilot owns the trigger; ignore manual taps so they can't double-fire
    // alongside an in-flight driver shot (which the protocol would reject).
    if (this.auto) return;
    const st = tunnel.state.inner;
    if (
      st.phase !== "playing" ||
      st.pendingShot ||
      st.turn !== "A" ||
      st.winner !== 0
    ) {
      return;
    }
    if (st.shotsAtB.some((s) => s.cell === cell)) return;
    try {
      tunnel.step({ type: "shoot", cell }, "A");
      this.lastYourShot = cell;
      this.pushView();
      void this.advance();
    } catch (e) {
      this.fail(e);
    }
  };
}

const botSessions = new Map<string, BotSession>();

function getBotSession(windowId: string): BotSession {
  let session = botSessions.get(windowId);
  if (!session) {
    session = new BotSession();
    botSessions.set(windowId, session);
    const created = session;
    registerWindowDisposer(windowId, "battleship-bot", () => {
      created.dispose();
      botSessions.delete(windowId);
    });
  }
  return session;
}

export function useBattleship(windowId: string): BattleshipSession {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();

  const session = getBotSession(windowId);
  session.deps = {
    report,
    account,
    client,
    signExec: (async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as never,
    sponsoredSignExec: sponsored.signExec as never,
    selectStakeCoin: sponsored.selectStakeCoin,
    prepareStake: sponsored.prepareStake,
    ensureStakeBalance: sponsored.ensureStakeBalance,
  };

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    status: snap.status,
    view: snap.view,
    error: snap.error,
    playBot: session.playBot,
    startBattle: session.startBattle,
    fire: session.fire,
    autoStartOnLoad: session.autoStartOnLoad,
    auto: snap.auto,
    setAuto: session.setAuto,
    pause: session.pause,
    resume: session.resume,
    score: snap.score,
    gamesPlayed: snap.gamesPlayed,
    playNextGame: session.playNextGame,
    settleNow: session.settleNow,
    reset: session.reset,
  };
}
