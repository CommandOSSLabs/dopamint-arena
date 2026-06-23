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
import { type BotDifficulty, DEFAULT_BOT_DIFFICULTY } from "./engine/bot";

/** DOPAMINT stake locked per seat (1 DOPAMINT, 9 decimals). */
const LOCKED_PER_SEAT = 1_000_000_000n;
/** SUI-fallback stake per seat (MIST), when the DOPAMINT env is unset. */
const SUI_PER_SEAT = 500n;
const STAKE = 100n;
/** Animation pacing for the bot's automatic moves (manual vs-bot — readable beats). */
const BOT_SHOOT_MS = 550;
const BOT_REVEAL_MS = 240;
/** Autopilot pacing — the floor: 0ms, so a self-playing match resolves as fast as
 *  the event loop allows. `sleep(0)` still yields one frame per step, so the boards
 *  repaint (not a single jump to the result) while staying near-instant. */
const AUTO_SHOOT_MS = 0;
const AUTO_REVEAL_MS = 0;

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
  /** Set the foe bot's skill — applies to its next shot (safe to change mid-match). */
  setDifficulty: (difficulty: BotDifficulty) => void;
  /** True while autopilot also fires YOUR shots; with it on, finished games rematch
   *  automatically on the SAME tunnel until you settle. */
  auto: boolean;
  /** Toggle autopilot for your seat; flipping it on resumes firing / auto-rematch. */
  setAuto: (on: boolean) => void;
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
  // Autopilot: when on, the driver fires YOUR shots too (with the same skill as
  // the foe), so the whole match plays itself. Lives on the session, not React,
  // because the off-React advance loop reads it each step.
  private auto = false;
  private snap: BotSnapshot = {
    status: "idle",
    view: null,
    error: null,
    auto: false,
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
  /** Foe bot skill; only affects shot selection, so it can change any time. */
  private difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY;
  // Bumped on reset/dispose so an in-flight bot loop knows to abandon ship.
  private gen = 0;
  // Control-plane TPS heartbeat (ADR-0002, self-play contract). The backend derives
  // live TPS from action COUNTS we send — never a rate. Registered once per match;
  // each co-signed update bumps `actions`/`moveCount`, flushed as a throttled window.
  private session: RegisterSessionResult | null = null;
  private moveCount = 0;
  private actions = 0;
  private lastHeartbeat = 0;

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
      gamesPlayed: this.tunnel?.state.gamesPlayed ?? 0,
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
    this.tunnel = null;
    this.protocol = null;
    this.transcript = null;
    this.secrets = null;
    this.session = null;
    this.score = { you: 0, foe: 0 };
    this.lastScoredGames = -1;
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
      // Settle through the backend /settle API: the server submits the close AND archives the
      // transcript to Walrus (ADR-0002/0005). Fall back to a sponsored/wallet close if it's down.
      const deps = this.deps; // non-null past the guard above; capture for the fallback closure
      const transcript = this.transcript;
      const settlement = tunnel.buildSettlementWithRoot(
        this.createdAt,
        transcript ? transcript.root() : new Uint8Array(32),
        0n,
      );
      const coinType = isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined;
      // DOPAMINT path closes via the gas sponsor too (so a 0-SUI player can close their bot
      // game for free); SUI path closes sender-pays. coinType must match the tunnel's coin.
      await settleViaBackend({
        tunnelId: this.tunnelId,
        settlement,
        transcript: transcript ? transcript.toRecord().entries : [],
        label: "battleship",
        fallbackClose: () =>
          closeCooperativeWithRoot({
            signExec: (isDopamintConfigured
              ? deps.sponsoredSignExec
              : deps.signExec) as never,
            tunnelId: this.tunnelId,
            settlement,
            coinType,
          }),
      });
      this.setStatus("settled");
    } catch (e) {
      this.fail(e);
    }
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
      while (tunnel && protocol && this.secrets) {
        const inner = tunnel.state.inner;
        if (inner.winner !== 0) {
          // A game finished. Tally it once, then decide: loop or stop.
          this.recordGameResult();
          this.pushView();
          const sessionDone = protocol.isTerminal(tunnel.state); // funds exhausted
          if (!this.auto || this.settleRequested || sessionDone) break;
          // Auto rematch on the SAME tunnel: fresh fleets, A's commit resets the board.
          const next = this.makeMatchSecrets();
          await sleep(AUTO_SHOOT_MS); // a beat so the final hit + new score register
          if (this.gen !== myGen || this.tunnel !== tunnel) return;
          this.secrets = next.secrets;
          this.placements = next.placements;
          this.lastYourShot = null;
          this.lastEnemyShot = null;
          tunnel.step(
            { type: "commit", root: next.secrets.A.commitment.root },
            "A",
          );
          this.pushView();
          continue;
        }
        const driven = nextMove(
          inner,
          this.secrets,
          Math.random,
          this.difficulty,
        );
        if (!driven) break;
        // Human's shot: stop and wait for fire() — unless autopilot is on, then drive it too.
        if (driven.by === "A" && driven.move.type === "shoot" && !this.auto)
          break;
        // Autopilot runs at near-instant pacing; manual vs-bot keeps readable beats.
        // Read `this.auto` fresh each step so toggling it changes the speed at once.
        if (driven.move.type === "shoot") {
          await sleep(this.auto ? AUTO_SHOOT_MS : BOT_SHOOT_MS);
          if (driven.by === "A") this.lastYourShot = driven.move.cell;
          else this.lastEnemyShot = driven.move.cell;
        } else if (driven.move.type === "reveal") {
          await sleep(this.auto ? AUTO_REVEAL_MS : BOT_REVEAL_MS);
        }
        if (this.gen !== myGen || this.tunnel !== tunnel) return; // reset/disposed mid-flight
        tunnel.step(driven.move, driven.by);
        if (driven.move.type === "reveal")
          this.reportShotTxn(driven.move, driven.by);
        this.pushView();
      }
      this.pushView();
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
    this.score = { you: 0, foe: 0 };
    this.lastScoredGames = -1;
    this.lastYourShot = null;
    this.lastEnemyShot = null;

    this.placements = placements;
    const human = makeFleetSecret(placementsToBoard(placements), randomSalts());
    const bot = randomFleetSecret(Math.random);
    this.secrets = { A: human, B: bot };

    const a = createParticipant("you-seat");
    const b = createParticipant("foe-seat");
    // Multi-game: one funded tunnel hosts many games; the player settles once.
    const protocol = new MultiGameBattleshipProtocol(STAKE);
    this.protocol = protocol;

    void (async () => {
      try {
        // Per-path stake: 1 DOPAMINT vs a tiny MIST amount on the SUI fallback (so the fallback
        // doesn't lock real SUI). The same value funds on-chain AND inits the off-chain tunnel.
        const stakePerSeat = isDopamintConfigured
          ? LOCKED_PER_SEAT
          : SUI_PER_SEAT;

        const reads = deps.client as unknown as Parameters<
          typeof openAndFundSelfPlay
        >[0]["reads"];
        this.setStatus("funding");
        const partyA = { address: a.address, publicKey: a.keyPair.publicKey };
        const partyB = { address: b.address, publicKey: b.keyPair.publicKey };
        // DOPAMINT (ADR-0010): faucet both seats' stake invisibly (gas-sponsored) and stake
        // DOPAMINT — free for a 0-SUI player. SUI path (DOPAMINT env unset): sponsored SUI stake
        // with a sender-pays fallback (ADR-0009).
        const tunnelId = isDopamintConfigured
          ? await openAndFundSelfPlay({
              reads,
              signExec: deps.sponsoredSignExec as never,
              partyA,
              partyB,
              aAmount: stakePerSeat,
              bAmount: stakePerSeat,
              coinType: DOPAMINT_COIN_TYPE,
              stakeCoinId: await deps.prepareStake(2n * stakePerSeat),
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
        const onChain = true;

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
          // moveCount is the monotonic nonce. Flush is self-throttled (~1/s).
          this.moveCount += 1;
          this.actions += 1;
          this.deps?.report.bumpCounters({
            updates: 1,
            signatures: 2,
            verifications: 2,
            bytes,
          });
          this.flushHeartbeat(false);
        };

        this.tunnel = tunnel;
        this.transcript = transcript;
        this.tunnelId = tunnelId;
        this.createdAt = createdAt;
        this.onChain = onChain;

        // Register the on-chain tunnel for control-plane TPS stats (ADR-0002). Best-effort:
        // the backend is never in the per-move loop, so a failed register must not block play.
        this.session = null;
        this.moveCount = 0;
        this.actions = 0;
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

  setDifficulty = (difficulty: BotDifficulty) => {
    this.difficulty = difficulty;
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
  };

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    status: snap.status,
    view: snap.view,
    error: snap.error,
    playBot: session.playBot,
    startBattle: session.startBattle,
    fire: session.fire,
    setDifficulty: session.setDifficulty,
    auto: snap.auto,
    setAuto: session.setAuto,
    score: snap.score,
    gamesPlayed: snap.gamesPlayed,
    playNextGame: session.playNextGame,
    settleNow: session.settleNow,
    reset: session.reset,
  };
}
