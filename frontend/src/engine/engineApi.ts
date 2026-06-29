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
import type { CoSignedSettlementWithRoot } from "sui-tunnel-ts/core/tunnel";
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
  resume(gameId: GameId): Promise<void>;
  submitInput(input: unknown): void;
  setAuto(on: boolean): void;
  setVisibility(visible: boolean): void;
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
  openTunnel(p: OpenTunnelParams, intentId?: string): Promise<{ tunnelId: string }>;
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
  createMatch(io: MatchIo<State, Move>): MatchController<State, Move, Setup, Input, View>;
}
