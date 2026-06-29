/**
 * Generic self-play (bot-vs-bot) session engine shared by every symmetric, public-seed,
 * multi-game tunnel game (bomb-it, chicken-cross). It owns the entire solo control plane — the
 * on-chain open/fund handshake + MTPS/SUI stake, the out-of-React session kept alive across window
 * remounts, the autopilot throughput loop with a manual take-over seat, the per-duel score tally,
 * the control-plane TPS heartbeat (ADR-0002), and the cooperative settle. A game supplies only a
 * `SoloSessionSpec`: its protocol, kit bots, view/result derivation, and how a per-seat "intent"
 * maps to a co-signed move. This mirrors `pvp/pvpMatchHook.ts` (the PvP path's shared engine); the
 * previous per-game solo hooks were ~700-line copies of this body, so collapsing them here makes
 * funding/settle/heartbeat/autopilot parity hold by construction instead of by careful copy-paste.
 *
 * Scope: multi-game self-play over `OffchainTunnel.selfPlay` (one funded tunnel, many duels). The
 * single-game PvP path is the sibling engine; hidden-info games are excluded from both.
 */
import { useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import type { TelemetryWriter } from "../../telemetry/TelemetryProvider";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "../../backend/controlPlane";
import { settleViaBackend } from "../../backend/settle";
import {
  closeCooperativeWithRoot,
  readCreatedAt,
  type SuiReads,
} from "../../onchain/tunnelTx";
import { useSponsoredSignExec } from "../../onchain/useSponsoredSignExec";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "../../onchain/mtps";
import {
  configureSharedBatcher,
  requestTunnelOpen,
} from "../../onchain/sharedTunnelOpenBatcher";
import type { TunnelOpenRequest } from "../../onchain/tunnelOpenBatcher";

/** Autopilot throughput loop (shared across games): co-sign up to MAX_STEPS_PER_FRAME ticks per
 *  FRAME_BUDGET_MS, then yield one frame — a fixed ~20% CPU duty so TPS is high yet the CPU cool. */
const FRAME_BUDGET_MS = 10;
const MAX_STEPS_PER_FRAME = 8;

/** MTPS bank locked per seat (1 MTPS, 9 decimals) — funds MANY per-game stakes. */
const LOCKED_PER_SEAT = 1n; // 1 MTPS per seat (MTPS is 0-decimal; ADR-0015)
/** SUI-fallback bank per seat (MIST), when the MTPS env is unset. */
const SUI_PER_SEAT = 500n;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A duel-advance outcome: one tick stepped, the inner duel ended, or the stake is exhausted. */
export type StepOutcome = "stepped" | "game-over" | "session-over";

export type SessionStatus =
  | "idle"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

/** The multi-game tunnel state shape the engine reads directly; games supply the rest via the spec. */
type MultiGameLike = {
  gamesPlayed: number;
  inner: { winner: "A" | "B" | "draw" | null };
};

/** Read (and clear) the player's queued intent for the take-over seat; null ⇒ autopilot this tick. */
type TakeIntent<Intent> = () => Intent | undefined;

/**
 * The per-game knowledge the engine needs. Every field is a real point of variation between two
 * games whose solo control flow is otherwise identical.
 *
 * @typeParam State  the multi-game protocol state (`{ gamesPlayed, inner: { winner } }`).
 * @typeParam Move   the inner protocol move (JSON-native).
 * @typeParam Intent a single seat's per-tick input (an action, a direction) before it becomes a Move.
 * @typeParam View   the flattened, render-ready snapshot the board consumes.
 * @typeParam Result who took the pot ("A" | "B" | "draw" | "push").
 * @typeParam Proto  the multi-game protocol instance (drives `stepWith`/`kickoffNextGame`).
 * @typeParam Bots   the per-seat kit bots, opaque to the engine and threaded into `stepWith`.
 */
export interface SoloSessionSpec<
  State extends MultiGameLike,
  Move,
  Intent,
  View,
  Result,
  Proto,
  Bots,
> {
  /** Control-plane + telemetry + window-disposer label (e.g. "bomb-it"). */
  game: string;
  /** `settleViaBackend` label (e.g. "bombIt") — the settlement's archive tag. */
  settleLabel: string;
  /** Per-game stake floor (the small per-duel swap), in the staked coin's base units. */
  minStake: bigint;
  /** Ephemeral key labels for the two seats (e.g. ["bomber-a", "bomber-b"]). */
  participants: readonly [string, string];
  /** A beat between finished duels so the result + updated score register before the rematch (ms). */
  rematchMs: number;
  /** When set, MANUAL play co-signs ONE tick per this many ms so the action stays reactable
   *  (e.g. bomb-it's fuse). When undefined, manual play batches at the autopilot rate. */
  manualStepMs?: number;
  /** ADR-0013: route the MTPS stake through the player's address balance (no version-pinned coin,
   *  so concurrent opens across games never equivocate). When false/undefined, stake a faucet coin. */
  usesAddressBalance?: boolean;
  makeProtocol: (tunnelId: string, stakePerGame: bigint) => Proto;
  makeBots: (stakePerGame: bigint) => Bots;
  deriveView: (state: State) => View;
  /** Map the just-settled inner state to the session's payout result. */
  sessionResult: (inner: State["inner"]) => Result;
  /** Co-sign one tick. `take` null ⇒ autopilot (bot steers both seats); non-null ⇒ the take-over
   *  seat consumes the player's queued intent this tick (the other seat stays bot-driven). */
  stepWith: (
    protocol: Proto,
    tunnel: OffchainTunnel<State, Move>,
    bots: Bots,
    take: TakeIntent<Intent> | null,
  ) => StepOutcome;
  /** Start the next duel on the SAME tunnel (seat A's reset first move). */
  kickoffNextGame: (tunnel: OffchainTunnel<State, Move>) => void;
}

/** The hook's reactive surface. Game wrappers rename `queueIntent` to their domain control. */
export interface SoloSession<Intent, View, Result> {
  status: SessionStatus;
  view: View | null;
  result: Result | null;
  stake: number;
  error: string | null;
  /** Auto mode: when on (default), a bot autopilots your seat; off = you play it yourself. */
  auto: boolean;
  /** Wins this session (one tunnel, many duels): `you` = seat A's wins, `foe` = seat B's. */
  score: { you: number; foe: number };
  /** Completed duels behind the current one (the running duel is `gamesPlayed + 1`). */
  gamesPlayed: number;
  start: (stake: number) => void;
  reset: () => void;
  /** Queue the take-over seat's next intent; the loop consumes it once. */
  queueIntent: (intent: Intent) => void;
  toggleAuto: () => void;
  /** Settle + close the tunnel NOW at the current co-signed state — cash out anytime. */
  settleNow: () => void;
  /** Freeze the self-play loop in place (cabinet hover). No-op unless mid-play. */
  pause: () => void;
  /** Unfreeze and re-kick the loop (cabinet un-hover). No-op unless paused. */
  resume: () => void;
}

/** React-supplied capabilities, refreshed each render (wallet may connect later). */
interface SoloDeps {
  report: TelemetryWriter;
  account: { address: string } | null;
  client: unknown;
  signExec: (tx: never) => Promise<{ digest: string }>;
  /** Backend-gas-sponsored signer (ADR-0009); falls back to signExec when the sponsor is down. */
  sponsoredSignExec: (tx: never) => Promise<{ digest: string }>;
  /** Pick a user coin to fund the (both-seat) bank; gas is sponsored, the stake is not. */
  selectStakeCoin: (minAmount: bigint) => Promise<string>;
  /** MTPS stake: faucet (invisibly, sponsored) if short, then return a stake coin id. */
  prepareStake: (minAmount: bigint) => Promise<string>;
  /** ADR-0013: ensure the player's MTPS address balance covers the stake. No-op once funded. */
  ensureStakeBalance: (minAmount: bigint) => Promise<void>;
  /** ADR-0019: enroll the open/fund in the shared coalescing batcher (one PTB per connect). */
  requestTunnelOpen: (req: TunnelOpenRequest) => Promise<string>;
}

interface SoloSnapshot<View, Result> {
  status: SessionStatus;
  view: View | null;
  result: Result | null;
  stake: number;
  error: string | null;
  auto: boolean;
  score: { you: number; foe: number };
  gamesPlayed: number;
}

/**
 * The solo (bot-vs-bot self-play) session, kept OUT of React so it survives the window unmounting
 * (minimize / maximize / desktop reflow). One funded tunnel hosts MANY duels; the player settles
 * once on demand. The component subscribes to it; only an explicit window close disposes it. See
 * `lib/windowSessions`.
 */
class SoloBotSession<
  State extends MultiGameLike,
  Move,
  Intent,
  View,
  Result,
  Proto,
  Bots,
> {
  deps: SoloDeps | null = null;

  private status: SessionStatus = "idle";
  private view: View | null = null;
  private result: Result | null = null;
  private error: string | null = null;
  // Autopilot: when on (default), the driver steers seat A too, so the whole duel plays
  // itself. Lives on the session, not React, because the off-React advance loop reads it
  // each step.
  private auto = true;
  private snap: SoloSnapshot<View, Result> = {
    status: "idle",
    view: null,
    result: null,
    stake: 0,
    error: null,
    auto: true,
    score: { you: 0, foe: 0 },
    gamesPlayed: 0,
  };
  private listeners = new Set<() => void>();

  private tunnel: OffchainTunnel<State, Move> | null = null;
  private protocol: Proto | null = null;
  // The seat bots that pick auto moves, built from the canonical kit so the in-game move
  // source matches the agent harness (kit = single source of bot behavior).
  private bots: Bots | null = null;
  // One tunnel hosts many duels; settlement is player-driven. `settleRequested`
  // stops the auto-rematch loop, `score`/`lastScoredGames` track the running tally.
  private settleRequested = false;
  private score = { you: 0, foe: 0 };
  private lastScoredGames = -1;
  private txnId = 0;
  private stake = 0;
  private tunnelId = "";
  private createdAt = 0n;
  private transcript: Transcript | null = null;
  private onChain = false;
  private advancing = false;
  // Cabinet hover-freeze: when true the advance loop returns at the top of its
  // next iteration (freeze in place); resume() clears it and re-kicks the loop.
  private paused = false;
  // Guards re-entry: a session that has begun a duel can't be restarted (only
  // reset()/Play Again returns it to idle). Stops StrictMode / double-click dupes.
  private starting = false;
  // When auto is off, the player queues a seat-A intent; the loop consumes it once.
  private pendingIntent: Intent | undefined = undefined;
  // Bumped on reset/dispose so an in-flight advance loop knows to abandon ship.
  private gen = 0;
  // Control-plane TPS heartbeat (ADR-0002, self-play contract). The backend derives
  // live TPS from action COUNTS we send — never a rate. Registered once per match;
  // each co-signed update bumps `actions`/`moveCount`, flushed as a throttled window.
  private session: RegisterSessionResult | null = null;
  private moveCount = 0;
  private actions = 0;
  private lastHeartbeat = 0;

  constructor(
    private readonly spec: SoloSessionSpec<
      State,
      Move,
      Intent,
      View,
      Result,
      Proto,
      Bots
    >,
  ) {}

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): SoloSnapshot<View, Result> => this.snap;

  private emit() {
    this.snap = {
      status: this.status,
      view: this.view,
      result: this.result,
      stake: this.stake,
      error: this.error,
      auto: this.auto,
      score: this.score,
      gamesPlayed: this.tunnel?.state.gamesPlayed ?? 0,
    };
    for (const l of this.listeners) l();
  }
  private setStatus(s: SessionStatus) {
    this.status = s;
    this.emit();
  }
  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }
  private pushView() {
    if (this.tunnel) this.view = this.spec.deriveView(this.tunnel.state);
    this.emit();
  }

  reset = () => {
    this.gen += 1;
    this.advancing = false;
    this.starting = false;
    this.settleRequested = false;
    this.tunnel = null;
    this.protocol = null;
    this.bots = null;
    this.transcript = null;
    this.session = null;
    this.score = { you: 0, foe: 0 };
    this.lastScoredGames = -1;
    this.txnId = 0;
    this.pendingIntent = undefined;
    this.deps?.report.setActive(0);
    this.status = "idle";
    this.view = null;
    this.result = null;
    this.stake = 0;
    this.error = null;
    this.emit();
  };

  dispose = () => {
    this.gen += 1;
    this.advancing = false;
    this.deps?.report.setActive(0);
    this.tunnel = null;
    this.protocol = null;
    this.bots = null;
    this.transcript = null;
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
      .catch((e) => console.error(`[${this.spec.game}] heartbeat failed:`, e));
  }

  /** Tally the just-finished inner duel once (keyed by gamesPlayed). Draw/push/null → no tally. */
  private recordGameResult() {
    if (!this.tunnel) return;
    const game = this.tunnel.state.gamesPlayed;
    if (game === this.lastScoredGames) return;
    const winner = this.tunnel.state.inner.winner; // "A" | "B" | "draw" | null
    this.lastScoredGames = game;
    if (winner === "A") this.score = { ...this.score, you: this.score.you + 1 };
    else if (winner === "B")
      this.score = { ...this.score, foe: this.score.foe + 1 };
    // One "My Activity" row per decided duel (skip draws/pushes), mirroring battleship.
    if (winner === "A" || winner === "B") {
      this.deps?.report.pushLocalTxn({
        id: (this.txnId += 1),
        game: this.spec.game,
        time: new Date().toLocaleTimeString("en-GB"),
        bot: "You",
        type: winner === "A" ? "Bot Win" : "Bot Loss",
        status: "Success",
        amount: "",
      });
    }
    // winner "draw"/null = no tally, duel still counts toward gamesPlayed.
  }

  /**
   * Drive the multi-game duel. AUTOPILOT batches co-signed ticks under a per-frame time budget
   * (the throughput benchmark loop); MANUAL co-signs one legible tick per `manualStepMs` when set
   * (so a fuse stays reactable), else batches too. Across duel boundaries: when a duel ends, record
   * the result and EITHER loop into the next duel on the same tunnel (autopilot on, fundable, no
   * settle pending) OR stop and leave the result on screen. Settlement is never automatic — the
   * player calls {@link settleNow}.
   */
  private advance = async () => {
    if (this.advancing) return;
    this.advancing = true;
    const myGen = this.gen;
    const tunnel = this.tunnel;
    const protocol = this.protocol;
    const bots = this.bots;
    // Consume the player's queued intent for the take-over seat (cleared after one read).
    const take: TakeIntent<Intent> = () => {
      const i = this.pendingIntent;
      this.pendingIntent = undefined;
      return i;
    };
    try {
      while (tunnel && protocol && bots) {
        if (this.paused) return; // hover-freeze: stop here; resume() re-kicks
        const manual = !this.auto;
        // A reaction game (manualStepMs set) co-signs ONE manual tick per frame so the fuse stays
        // legible; everything else batches as many ticks as fit the frame budget, then yields once.
        const oneShot = manual && this.spec.manualStepMs != null;
        let boundary: StepOutcome = "stepped";
        if (oneShot) {
          boundary = this.spec.stepWith(protocol, tunnel, bots, take);
          if (boundary === "stepped") {
            this.moveCount += 1;
            this.actions += 1;
          }
        } else {
          // Render + heartbeat run once per frame (below), not per tick — that decoupling is what
          // keeps TPS high without pegging the CPU. Manual non-reaction games read the queued
          // intent per tick (consumed once, the rest of the frame holds position).
          const deadline = performance.now() + FRAME_BUDGET_MS;
          for (let n = 0; n < MAX_STEPS_PER_FRAME; n++) {
            boundary = this.spec.stepWith(
              protocol,
              tunnel,
              bots,
              manual ? take : null,
            );
            if (boundary !== "stepped") break;
            this.moveCount += 1;
            this.actions += 1;
            if (performance.now() >= deadline) break;
          }
        }
        this.pushView();
        this.flushHeartbeat(false);
        if (boundary === "stepped") {
          await sleep(oneShot ? this.spec.manualStepMs! : 0);
          if (this.gen !== myGen || this.tunnel !== tunnel) return;
          continue;
        }
        if (boundary === "session-over") {
          this.recordGameResult(); // tally the final decided duel (idempotent via lastScoredGames)
          this.pushView();
          break; // exhausted — leave for settle
        }
        // boundary === "game-over": record, then rematch (auto) or stop.
        this.recordGameResult();
        this.pushView();
        if (!this.auto || this.settleRequested) break;
        await sleep(this.spec.rematchMs); // a beat so the result + score register
        if (this.gen !== myGen || this.tunnel !== tunnel) return;
        this.spec.kickoffNextGame(tunnel);
        this.pushView();
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.advancing = false;
    }
  };

  start = (nextStake: number) => {
    const deps = this.deps;
    if (!deps) return;
    // Solo play is on-chain only: a connected wallet funds + settles the self-play
    // tunnel (gas sponsored, MTPS stake). No wallet → require connect, not a demo.
    if (!deps.account) {
      this.error = "connect a wallet to stake the tunnel";
      this.status = "error";
      this.emit();
      return;
    }
    // Only a fresh/idle session may start; a live duel never restarts itself.
    if (this.starting || this.status !== "idle") return;
    this.starting = true;
    this.gen += 1;
    this.error = null;
    this.result = null;
    this.settleRequested = false;
    this.score = { you: 0, foe: 0 };
    this.lastScoredGames = -1;
    this.txnId = 0;
    this.pendingIntent = undefined;
    this.paused = false;

    // The bank funded on-chain per seat. Each duel wagers the per-game stake off it, so the stake
    // must never exceed the bank — else the first duel underflows a seat's balance (u64 out of range:
    // e.g. a 1-token MTPS bank with a 500 lobby stake → 1 - 500 = -499).
    const fundedPerSeat = isMtpsConfigured ? LOCKED_PER_SEAT : SUI_PER_SEAT;
    // Per-game stake from the lobby (the small swap): floored at the game's minimum, capped at the
    // bank so a single duel can't wager more than a seat holds.
    const floored = Math.floor(nextStake);
    const stakePerGame = BigInt(
      Math.min(
        Number(fundedPerSeat),
        Math.max(
          Number(this.spec.minStake),
          Number.isFinite(floored) ? floored : 0,
        ),
      ),
    );
    this.stake = Number(stakePerGame);
    this.emit();

    const a = createParticipant(this.spec.participants[0]);
    const b = createParticipant(this.spec.participants[1]);

    void (async () => {
      try {
        const reads = deps.client as unknown as SuiReads;
        this.setStatus("funding");
        const partyA = { address: a.address, publicKey: a.keyPair.publicKey };
        const partyB = { address: b.address, publicKey: b.keyPair.publicKey };
        // ADR-0019: all funding-mode branching (MTPS balance / MTPS coin / SUI fallback) now lives
        // in the shared batcher so concurrent opens across game windows coalesce into one PTB.
        const tunnelId = await deps.requestTunnelOpen({
          partyA,
          partyB,
          aAmount: fundedPerSeat,
          bAmount: fundedPerSeat,
          coinType: isMtpsConfigured ? MTPS_COIN_TYPE : undefined,
          usesAddressBalance: this.spec.usesAddressBalance,
        });
        const createdAt = await readCreatedAt(reads, tunnelId);

        // Multi-game: many duels on one funded tunnel; the player settles once. The per-game
        // stake is the SMALL swap, the funded bank above is what survives across duels.
        const protocol = this.spec.makeProtocol(tunnelId, stakePerGame);
        // Auto moves come from the canonical kit bot — the same move source the agent harness uses —
        // so the kit is the single source of bot behavior. Built with the SAME per-game stake as the
        // tunnel's protocol (so the bot's fund/terminal checks match) and live per-seat RNG.
        const bots = this.spec.makeBots(stakePerGame);
        const tunnel = OffchainTunnel.selfPlay(
          protocol as never,
          tunnelId,
          a.keyPair,
          b.keyPair,
          a.address,
          b.address,
          { a: fundedPerSeat, b: fundedPerSeat },
        ) as OffchainTunnel<State, Move>;
        // Record every co-signed update so the close can anchor the transcript root on-chain
        // (close_cooperative_with_root) and the backend can archive the proof to Walrus.
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
        this.protocol = protocol;
        this.bots = bots;
        this.transcript = transcript;
        this.tunnelId = tunnelId;
        this.createdAt = createdAt;
        this.onChain = true;

        // Register the on-chain tunnel for control-plane TPS stats (ADR-0002). Best-effort:
        // the backend is never in the per-move loop, so a failed register must not block play.
        this.session = null;
        this.moveCount = 0;
        this.actions = 0;
        this.lastHeartbeat = Date.now();
        getControlPlaneClient()
          .registerSession({
            userAddress: a.address,
            game: this.spec.game,
            tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
          })
          .then((s) => {
            this.session = s;
          })
          .catch((e) =>
            console.error(`[${this.spec.game}] registerSession failed:`, e),
          );

        this.deps?.report.bumpCounters({ tunnelsOpened: 1 });
        this.deps?.report.setActive(2);
        this.starting = false;
        this.setStatus("playing");
        this.pushView();
        void this.advance();
      } catch (e) {
        this.starting = false;
        this.deps?.report.setActive(0);
        this.fail(e);
      }
    })();
  };

  /**
   * Close the tunnel NOW at the current co-signed state — allowed anytime, even mid-duel
   * (which pays out the net of finished duels and voids the running one). Stops the
   * autopilot loop first so nothing steps while the close is built. Anchors the
   * transcript root on-chain (close_cooperative_with_root), settling through the backend.
   */
  private settle = async () => {
    const tunnel = this.tunnel;
    if (!tunnel) return;
    this.result = this.spec.sessionResult(tunnel.state.inner);
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
      const coinType = isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
      // MTPS path closes via the gas sponsor too (so a 0-SUI player can close their
      // bot game for free); SUI path closes sender-pays. coinType must match the tunnel's coin.
      await settleViaBackend({
        tunnelId: this.tunnelId,
        settlement,
        transcript: transcript ? transcript.rawEntries() : [],
        label: this.spec.settleLabel,
        fallbackClose: () =>
          closeCooperativeWithRoot({
            signExec: (isMtpsConfigured
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

  queueIntent = (intent: Intent) => {
    this.pendingIntent = intent;
  };

  toggleAuto = () => {
    this.auto = !this.auto;
    this.pendingIntent = undefined;
    this.emit();
    // Turning autopilot on while a duel is live: kick the driver so it steers / loops.
    if (this.auto && this.status === "playing") void this.advance();
  };

  pause = () => {
    if (this.status !== "playing") return;
    this.paused = true;
  };

  resume = () => {
    if (!this.paused) return;
    this.paused = false;
    if (this.status === "playing") void this.advance();
  };

  /** Settle + close the tunnel NOW at the current co-signed state — cash out anytime,
   *  even mid-duel. Stops the autopilot loop first so nothing steps during the close. */
  settleNow = () => {
    if (this.status !== "playing") return;
    this.settleRequested = true;
    this.gen += 1; // make the in-flight advance loop bail before its next step
    this.advancing = false;
    void this.settle();
  };
}

/**
 * Build a React hook that drives this game's self-play sessions. Sessions live in a module-level map
 * keyed by `windowId` (one map per game, since each game calls this once) so a window can
 * minimize/reflow without losing the funded tunnel; the window-close disposer tears it down.
 */
export function createSoloSessionHook<
  State extends MultiGameLike,
  Move,
  Intent,
  View,
  Result,
  Proto,
  Bots,
>(
  spec: SoloSessionSpec<State, Move, Intent, View, Result, Proto, Bots>,
): (windowId: string) => SoloSession<Intent, View, Result> {
  const sessions = new Map<
    string,
    SoloBotSession<State, Move, Intent, View, Result, Proto, Bots>
  >();

  function getSession(
    windowId: string,
  ): SoloBotSession<State, Move, Intent, View, Result, Proto, Bots> {
    let session = sessions.get(windowId);
    if (!session) {
      session = new SoloBotSession(spec);
      sessions.set(windowId, session);
      const created = session;
      registerWindowDisposer(windowId, `${spec.game}-bot`, () => {
        created.dispose();
        sessions.delete(windowId);
      });
    }
    return session;
  }

  return function useSoloSession(
    windowId: string,
  ): SoloSession<Intent, View, Result> {
    const { report } = useTelemetry();
    const account = useCurrentAccount();
    const client = useSuiClient();
    const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
    const sponsored = useSponsoredSignExec();

    const session = getSession(windowId);
    const walletSignExec = (async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as never;
    session.deps = {
      report,
      account,
      client,
      signExec: walletSignExec,
      sponsoredSignExec: sponsored.signExec as never,
      selectStakeCoin: sponsored.selectStakeCoin,
      prepareStake: sponsored.prepareStake,
      ensureStakeBalance: sponsored.ensureStakeBalance,
      requestTunnelOpen,
    };
    // Called every render so the shared singleton always holds the current signer (latest-wins;
    // safe because start() already guards `if (!deps.account) return`).
    configureSharedBatcher({
      reads: client as never,
      sponsoredSignExec: sponsored.signExec as never,
      signExec: walletSignExec,
      ensureStakeBalance: sponsored.ensureStakeBalance,
      prepareStake: sponsored.prepareStake,
      selectStakeCoin: sponsored.selectStakeCoin,
    });

    const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
    return {
      status: snap.status,
      view: snap.view,
      result: snap.result,
      stake: snap.stake,
      error: snap.error,
      auto: snap.auto,
      score: snap.score,
      gamesPlayed: snap.gamesPlayed,
      start: session.start,
      reset: session.reset,
      queueIntent: session.queueIntent,
      toggleAuto: session.toggleAuto,
      settleNow: session.settleNow,
      pause: session.pause,
      resume: session.resume,
    };
  };
}
