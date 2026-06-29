/**
 * Contracts for the browser tunnel-client Web Worker (design:
 * docs/design/frontend-tunnel-client-worker.md).
 *
 * Per-game-worker model: `engineClient` (main) spawns ONE dedicated worker per game
 * window. The worker owns the WebSocket + `DistributedTunnel` + ephemeral signing + any
 * hidden-info secret; the main thread renders snapshots and serves wallet/Sui-client/
 * localStorage through the bridge.
 *
 * The boundary is Comlink (`EngineApi` below): commands + the snapshot/bridge callbacks cross
 * as RPC; their *payloads* are plain / structured-cloneable (the callbacks themselves ride as
 * `Comlink.proxy`'d references). Closures (a game's `Protocol`, `MoveCodec`, `GameSessionSpec`)
 * are imported INSIDE the worker and addressed by `gameId` — they are never sent across.
 */
import type { Role } from "@/pvp/mpClient";
import type { Protocol } from "sui-tunnel-ts/protocol/Protocol";
import type { MoveCodec } from "sui-tunnel-ts/core/distributedFrame";
import type { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import type {
  CoSignedSettlementWithRoot,
  OffchainTunnel,
} from "sui-tunnel-ts/core/tunnel";
import type { ResumeAdapter } from "@/pvp/resumeSession";

/** A registered game's matchmaking/spec key (e.g. "bomb-it"). */
export type GameId = string;

export type EngineStatus =
  | "idle"
  | "matching"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export type ConnStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * The coalesced, render-ready snapshot the UI consumes — a superset of the two existing
 * `PvpSnapshot` shapes. `view` is the game's `deriveView` output; all fields are plain.
 */
export interface MatchSnapshot<View = unknown, Winner = unknown> {
  status: EngineStatus;
  role: Role | null;
  auto: boolean;
  /** Per-seat stake (MIST) surfaced in the outcome banner. */
  stake: number;
  view: View | null;
  winner: Winner;
  opponentWallet: string | null;
  /** The active tunnel's on-chain id, or null before funding (no synthetic ids — design §4). */
  tunnelId: string | null;
  /** Socket lifecycle for this match, folded in from the worker (design §7). */
  connStatus: ConnStatus;
  error: string | null;
  /**
   * Set by the main-thread manager (never the worker) when the device live-window cap
   * (design §2.1) refused to spawn this window's worker. The UI keys off this to fall back to
   * an SSE-spectate tile instead of an interactive worker-hosted match.
   */
  capped?: boolean;
  /**
   * Self-play only (omitted on the PvP path): running per-seat win tally across the multi-duel
   * session — `you` = seat A's wins, `foe` = seat B's. One funded tunnel hosts many duels.
   */
  score?: { you: number; foe: number };
  /** Self-play only: completed duels behind the running one (the live duel is `gamesPlayed + 1`). */
  gamesPlayed?: number;
  /** Self-play only: the session payout result (game-specific), set once the tunnel settles. */
  result?: unknown;
}

/** Worker bootstrap config (the wallet address is only a matchmaking label). */
export interface EngineConfig {
  backendUrl: string;
  wallet: string;
}

// --- Worker RPC surface (Comlink; one worker per window, so no windowId) ------------------

/**
 * The engine API the worker `Comlink.expose`s and `engineClient` `Comlink.wrap`s (design §4,
 * channel 1). Replaces the old hand-rolled `postMessage` envelopes: each method is a Comlink
 * RPC, so on main every method is awaitable (`Comlink.Remote<EngineApi>` promisifies them all).
 *
 * Setup order: `engineClient` posts `init` → `attachBridge` → `subscribe` once at spawn, in that
 * order and without awaiting between them — Comlink preserves channel order, so they land before
 * any later `findMatch`/`resume`.
 *
 * Proxy lifetimes: `attachBridge`'s `bridge` and `subscribe`'s `onSnapshot` are `Comlink.proxy`'d
 * on main, so the worker invokes them by reference (each call RPCs back to main). Both live as
 * long as the worker; `engineClient.dispose` releases the wrapped API and `terminate()`s the
 * worker, which disentangles both proxy ports so no main-side `MessagePort` listener leaks.
 */
export interface EngineApi {
  /** Bootstrap config (main-resolved WS URL + wallet label); set before the first match. */
  init(config: EngineConfig): void;
  /** Hand the worker the main-thread chain bridge (a Comlink proxy; its methods RPC to main). */
  attachBridge(bridge: MainBridge): void;
  /** Register the coalesced-snapshot sink (a Comlink proxy, invoked ~per move / 16 ms). */
  subscribe(onSnapshot: (snap: MatchSnapshot) => void): void;
  findMatch(gameId: GameId, setup?: unknown): Promise<void>;
  /**
   * Self-play (bot-vs-bot) over ONE funded tunnel hosting many duels. A window is EITHER solo or
   * pvp; the worker routes control commands (input/auto/visibility/reset) to whichever lane started.
   * `setup` is the optional per-duel stake (a number, or `{ stake }`); defaults to the spec's stake.
   */
  findSoloMatch(gameId: GameId, setup?: unknown): Promise<void>;
  resume(gameId: GameId): Promise<void>;
  submitInput(input: unknown): void;
  setAuto(on: boolean): void;
  setVisibility(visible: boolean): void;
  /**
   * SOLO lane only: cabinet hover-freeze. Pause (true) / resume (false) the self-play advance loop
   * AND its snapshot flush — independent of {@link setVisibility} (the tab-visibility driver). The
   * loop runs only when BOTH say "active", so one resuming never overrides the other still paused.
   * No-op unless the window's active lane is solo (the PvP lane has no self-play loop to freeze).
   */
  setPaused(paused: boolean): void;
  /**
   * SOLO lane only: on-demand cooperative cash-out. Close the funded tunnel NOW at the current
   * co-signed state — the SAME settle path the engine runs when the per-seat bank is exhausted, but
   * player-triggered so a session can be cashed out mid-play instead of only at exhaustion. No-op
   * unless the active lane is solo and a match is playing; idempotent if already settling/settled.
   */
  settleSolo(): void;
  /** Tear the match down. Async because it first cancels any seat-A open still queued in the
   *  main-thread bulk-open window (orphan-tunnel cancel, design §4.1) via `bridge.cancelOpen`;
   *  `engineClient.disposeWindow` awaits this so the cancel lands before it terminates the worker. */
  reset(): Promise<void>;
}

// --- Bridge: the few privileged ops the worker calls back into main for -------------------

export interface PartyRef {
  address: string;
  publicKey: Uint8Array;
}
export interface OpenTunnelParams {
  partyA: PartyRef;
  partyB: PartyRef;
  amount: bigint;
  label: string;
}
export interface DepositStakeParams {
  tunnelId: string;
  amount: bigint;
  label: string;
}
/** Self-play open: BOTH ephemeral-bot seats funded from one wallet in a single signature. The
 *  amounts are the LARGE per-seat bank (vs the small per-duel stake) — one tunnel hosts many duels. */
export interface OpenSelfPlayParams {
  partyA: PartyRef;
  partyB: PartyRef;
  aAmount: bigint;
  bAmount: bigint;
  label: string;
}
export interface CloseFallbackParams {
  tunnelId: string;
  settlement: CoSignedSettlementWithRoot;
  coinType?: string;
}

/**
 * Implemented on MAIN (dapp-kit signers + Sui client live there) and called FROM the worker.
 * All `@mysten/sui` tx-building stays behind these coarse ops. The happy-path settle
 * (`cp.settle`) is plain `fetch` and runs in the worker, not here. Resume persistence is NOT
 * on the bridge — the worker owns it in its own IndexedDB (`persist/idb.ts`, design §5/§6).
 */
export interface MainBridge {
  /** Role A: open + fund the shared tunnel on-chain; returns its id. `intentId` (minted by the
   *  worker per open) tags the queued bulk-open intent so a teardown can {@link cancelOpen} it. */
  openTunnel(
    p: OpenTunnelParams,
    intentId?: string,
  ): Promise<{ tunnelId: string }>;
  /** Self-play: open + fund BOTH ephemeral seats in ONE signature; returns the shared tunnel id.
   *  The single per-duel loop is pure crypto, so only this open and the close cross the bridge. */
  openSelfPlay(p: OpenSelfPlayParams): Promise<{ tunnelId: string }>;
  /** Cancel a still-queued seat-A open (orphan-tunnel cancel, design §4.1): the match/window was
   *  torn down inside the bulk-open window, so its pending open must not flush a tunnel (and
   *  consume stake). No-op if the intent already flushed into an in-flight PTB. */
  cancelOpen(intentId: string): Promise<void>;
  /** Role B: deposit this seat's stake into the opened tunnel. */
  depositStake(p: DepositStakeParams): Promise<void>;
  /** Settle: read the tunnel's on-chain `createdAt` for the settlement timestamp. */
  readCreatedAt(tunnelId: string): Promise<bigint>;
  /** Settle fallback only (backend `/settle` down): wallet-submitted cooperative close. */
  closeFallback(p: CloseFallbackParams): Promise<void>;
}

// --- Per-game spec (imported in the worker, addressed by gameId) --------------------------

/** What the engine hands a game's controller for one match. */
export interface MatchIo<State, Move> {
  role: Role;
  /** The live tunnel for this match (null before activation). */
  tunnel(): DistributedTunnel<State, Move> | null;
  /** Current auto/autopilot state for this seat (engine-owned). */
  auto(): boolean;
  /** Ask the engine to re-derive the view and flush a coalesced snapshot. */
  emitView(): void;
}

/**
 * The per-match, game-specific brain. Closes over this match's private local state (secret,
 * placements, last shots). The engine calls these at well-defined points; the spec owns the
 * game logic and — critically — the move ordering (`onTick`).
 */
export interface MatchController<State, Move, Setup, Input, View> {
  /** Build any secret/local state from the UI's `findMatch(setup)` (no-op for public-state). */
  initSetup(setup: Setup): void;
  /** After each confirmed update: drive the due move (proposeDue / maybePropose). */
  onConfirmed(): void;
  /** Queue a human input (fire/intent) and propose if applicable. */
  onInput(input: Input): void;
  /** Auto/autopilot toggled for this seat; (re)evaluate whether to propose. */
  setAuto(on: boolean): void;
  /** Render-ready view from the display state — the only game data that reaches the UI. */
  deriveView(displayState: State): View;
  /** Persist/restore incl. any secret; wired when resume lands (optional for now). */
  resumeAdapter?(): ResumeAdapter<State, Move>;
  /** One activity/telemetry row per finished match; reads `io.tunnel()` for the result. */
  onSettled?(): void;
  /** Clear any timers/local state when the match ends. */
  dispose(): void;
}

/**
 * Everything game-specific the generic engine needs, registered by `gameId`. The engine
 * supplies the skeleton (matchmaking, role-asymmetric funding, settle, resume, snapshot);
 * the spec supplies protocol + codec + the per-match controller.
 *
 * @typeParam State must carry a `winner` the snapshot reads.
 */
export interface GameSessionSpec<
  State extends { winner: unknown },
  Move,
  Setup,
  Input,
  View,
> {
  game: GameId;
  /** Per-seat stake locked on-chain (MIST). */
  stake: bigint;
  /** Optional idle pacing for an auto/bot seat (ms); event-driven games omit it. */
  stepMs?: number;
  makeProtocol(): Protocol<State, Move>;
  /** REQUIRED iff `protocol.movesCarrySecrets` — the tunnel enforces this. */
  moveCodec?: MoveCodec<Move>;
  createMatch(
    io: MatchIo<State, Move>,
  ): MatchController<State, Move, Setup, Input, View>;
}

// --- Self-play (solo) lane: one funded tunnel hosts many bot-vs-bot duels --------------------

/**
 * The multi-duel protocol state the `SoloEngine` reads directly (it tallies per-duel winners and
 * surfaces `gamesPlayed`). A game's full state extends this; everything else is opaque to the engine.
 */
export interface SoloMultiGameState {
  /** Completed duels behind the running one (the live duel is `gamesPlayed + 1`). */
  gamesPlayed: number;
  /** The running duel's protocol state; `winner` stays null until that duel decides. */
  inner: { winner: "A" | "B" | "draw" | null };
}

/** One `stepWith` outcome: a tick was co-signed, the inner duel ended, or the bank is exhausted. */
export type SoloStepOutcome = "stepped" | "game-over" | "session-over";

/** Read (and clear) the take-over seat's queued intent; a null/undefined return ⇒ autopilot this
 *  tick (the bot steers the seat). The engine consumes the queued intent exactly once. */
export type SoloTakeIntent<Intent> = () => Intent | undefined;

/**
 * Everything game-specific the generic `SoloEngine` needs, registered by `gameId` (parallel to
 * {@link GameSessionSpec} for the PvP lane). The engine owns the solo skeleton — the one-signature
 * open+fund of BOTH ephemeral seats over the bridge, the `OffchainTunnel.selfPlay` per-duel loop,
 * the autopilot/manual cadence, multi-duel rematch, transcript, and cooperative settle; the spec
 * supplies the protocol, bots, view/result derivation, and the per-tick co-sign.
 *
 * `Bots` and `Proto` are trailing defaulted generics so the canonical `<State, Move, Intent, View,
 * Result>` form stays the usage site while a game can still type its bots/protocol precisely.
 *
 * @typeParam State the multi-duel protocol state (`{ gamesPlayed, inner: { winner } }`).
 * @typeParam Move  the inner protocol move (JSON-native).
 * @typeParam Intent a single seat's per-tick input (an action/direction) before it becomes a Move.
 * @typeParam View  the flattened, render-ready snapshot the board consumes.
 * @typeParam Result who took the pot ("A" | "B" | "draw" | "push").
 */
export interface SoloGameSpec<
  State extends SoloMultiGameState,
  Move,
  Intent,
  View,
  Result,
  Bots = unknown,
  Proto = Protocol<State, Move>,
> {
  game: GameId;
  /** Per-DUEL stake (the small swap settled each duel), in the staked coin's base units. The LARGE
   *  per-seat bank the engine funds on-chain (which survives many duels) is derived by the engine. */
  stake: bigint;
  /**
   * The LARGE per-seat bank funded on-chain (the staked coin's base units), which survives MANY
   * duels — distinct from the small per-duel {@link stake}. Defaults to the engine's 1-MTPS bank;
   * a game whose on-chain balance IS its in-game stack (e.g. poker's chip buy-in) overrides it so
   * the funded bank equals the protocol's starting balances. (SUI-fallback funding ignores this.)
   */
  lockedPerSeat?: bigint;
  /** Idle pacing for an auto/bot seat (ms); a throughput showcase may omit it. */
  stepMs?: number;
  /** A beat between finished duels so the result + score register before the rematch (ms). */
  rematchMs?: number;
  /** When set, MANUAL play co-signs ONE tick per this many ms so a reaction game's fuse stays
   *  legible; when undefined, manual play batches at the autopilot rate. */
  manualStepMs?: number;
  /** Build the multi-duel protocol once the tunnel id + per-duel stake are known. */
  makeProtocol(tunnelId: string, stakePerGame: bigint): Proto;
  /** Build the per-seat kit bots for this stake; opaque to the engine, threaded into `stepWith`. */
  makeBots(stakePerGame: bigint): Bots;
  deriveView(state: State): View;
  /** Map the just-settled inner duel to the session's payout result. */
  sessionResult(inner: State["inner"]): Result;
  /** Co-sign one tick. `take` null ⇒ autopilot (bot drives both seats); non-null ⇒ the take-over
   *  seat consumes the player's queued intent this tick (the other seat stays bot-driven). */
  stepWith(
    protocol: Proto,
    tunnel: OffchainTunnel<State, Move>,
    bots: Bots,
    take: SoloTakeIntent<Intent> | null,
  ): SoloStepOutcome;
  /** Start the next duel on the SAME tunnel (seat A's reset first move). */
  kickoffNextGame(tunnel: OffchainTunnel<State, Move>): void;
}
