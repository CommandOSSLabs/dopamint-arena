// engine-loop core: settle, transcript root, deferred-confirm fix
import { core, bytesToHex, hexToBytes } from "sui-tunnel-ts";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import type { SettlementWithRoot } from "sui-tunnel-ts/core/wire";
import type { CoSignedSettlementWithRoot } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import type { GameKit, GameBot, BotContext } from "@/agent/gameKit";
import { SnapshotStore } from "./snapshotStore";
import type {
  SessionRelay,
  SessionTransport,
  PartyEndpointFactory,
  SettlementSigner,
  MatchChannel,
} from "./seams";

export type SessionPhase =
  | "idle"
  | "connecting"
  | "queuing"
  | "opening"
  | "funding"
  | "playing"
  | "settling"
  | "done"
  | "error"
  | "opponent-abandoned";

export interface SessionSnapshot<S> {
  phase: SessionPhase;
  state: S | null;
  balances: { a: bigint; b: bigint } | null;
  terminal: boolean;
  error: string | null;
  /** On-chain tx digest from cooperative close (set when phase = "done"). */
  digest?: string;
}

// Minimal structural view of the engine the session drives (verified API subset).
// onConfirmed passes a CoSignedUpdate to match DistributedTunnel's actual signature.
interface TunnelLike<S, M> {
  readonly tunnelId: string;
  /** Current committed off-chain nonce.  Incremented only on confirmed ACK. */
  readonly nonce: bigint;
  state: S;
  latest: CoSignedUpdate | null;
  onConfirmed?: ((u: CoSignedUpdate) => void) | undefined;
  propose(move: M, timestamp: bigint): void;
  buildSettlementHalfWithRoot(
    createdAt: bigint,
    root: Uint8Array,
    onchainNonce: bigint,
  ): { settlement: SettlementWithRoot; sigSelf: Uint8Array };
  combineSettlementWithRoot(
    settlement: SettlementWithRoot,
    sigSelf: Uint8Array,
    sigOther: Uint8Array,
  ): CoSignedSettlementWithRoot;
}

/** Timeout durations — injectable so tests use tiny values without real waits. */
export interface SessionTimeouts {
  /**
   * How long (ms) to wait for our proposed move to be ACK'd before treating the
   * opponent as abandoned.  Default: 30_000.
   */
  moveTimeoutMs: number;
  /**
   * How long (ms) to wait for the opponent's settle-half during cooperative close
   * before escalating to a non-cooperative `closeOnTimeout`.  Default: 30_000.
   */
  settleTimeoutMs: number;
}

const DEFAULT_TIMEOUTS: SessionTimeouts = {
  moveTimeoutMs: 30_000,
  settleTimeoutMs: 30_000,
};

/** Optional deps for start(): injected by fleet code, omitted in loopback tests. */
interface StartDeps {
  relay: SessionRelay;
  endpointFactory: PartyEndpointFactory;
  settlementSigner: SettlementSigner;
}

/** Args for the explicit settle() call (invoked after phase reaches "settling"). */
export interface SettleArgs {
  channel: MatchChannel;
  settlementSigner: SettlementSigner;
  /** On-chain tunnel creation timestamp (from readCreatedAt). Use 0n in tests. */
  createdAt: bigint;
  /** Latest on-chain nonce (from chain state). Use 0n in tests. */
  onchainNonce: bigint;
}

export class PvpGameSession<S, M> {
  private readonly bot: GameBot<S, M>;
  private readonly store: SnapshotStore<SessionSnapshot<S>>;
  private tunnel: TunnelLike<S, M> | null = null;
  private transport: SessionTransport | null = null;
  private auto = false;
  // Non-readonly so attachTunnel can assign directly (no cast needed).
  private transcript: Transcript;
  private readonly startDeps: StartDeps | undefined;
  private readonly timeouts: SessionTimeouts;

  // Deferred-confirm state: track the nonce of the move we proposed so we can
  // confirm it after the co-signed ACK arrives.
  //
  // ASSUMPTION (strictly-alternating turns): The nonce-match below is correct
  // for any kit where each seat proposes exactly once per turn.  For a
  // non-alternating kit (e.g. concurrent proposals) the confirmed nonce could
  // belong to the opponent's accepted move rather than ours.  If that becomes
  // a concern, gate on `pendingNonce !== null && u.update.nonce === pendingNonce`
  // AND also check that the proposing party matches `this.seat`.
  private pendingMove: M | null = null;
  private pendingNonce: bigint | null = null;

  // Active timers — cleared whenever the session reaches any terminal phase.
  private moveTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly kit: GameKit<S, M>,
    private readonly seat: Party,
    ctx: BotContext,
    startDeps?: StartDeps,
    timeoutOverrides?: Partial<SessionTimeouts>,
  ) {
    this.bot = kit.createBot(seat, ctx);
    // Transcript is per-session; tunnelId is known only after attachTunnel, so
    // we initialise with an empty string and reset it there.
    this.transcript = new Transcript("");
    this.store = new SnapshotStore<SessionSnapshot<S>>({
      phase: "idle",
      state: null,
      balances: null,
      terminal: false,
      error: null,
    });
    this.startDeps = startDeps;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeoutOverrides };
  }

  /**
   * Release all resources held by this session.  Must be called when the
   * session is no longer needed (e.g. component unmount) to prevent timer leaks.
   */
  dispose(): void {
    this.clearTimers();
  }

  // Test/Task-4 seam: inject a ready tunnel + seeded state.
  attachTunnel(deps: { tunnel: TunnelLike<S, M>; initialState: S; transport?: SessionTransport }): void {
    this.tunnel = deps.tunnel;
    // Re-initialise the Transcript with the real tunnelId now that it's known.
    this.transcript = new Transcript(deps.tunnel.tunnelId);
    this.tunnel.onConfirmed = (u: CoSignedUpdate) => this.onConfirmed(u);

    // Wire transport disconnect signals so a dropped peer transitions to a
    // first-class terminal phase rather than hanging a lane indefinitely.
    if (deps.transport) {
      this.transport = deps.transport;
      deps.transport.onClose(() => this.abandon());
      deps.transport.onError(() => this.abandon());
    }

    this.publish("playing", deps.initialState);
  }

  setAuto(on: boolean): void {
    this.auto = on;
  }

  getSnapshot(): Readonly<SessionSnapshot<S>> {
    return this.store.get();
  }

  subscribe(cb: () => void): () => void {
    return this.store.subscribe(cb);
  }

  /** Hex-encoded Merkle root over all co-signed updates accumulated so far. */
  transcriptRootHex(): string {
    return bytesToHex(this.transcript.root());
  }

  /** Seat A makes the opening proposal; both seats then react on confirmation. */
  kickoff(): void {
    this.drive();
  }

  /**
   * Full matchmaking-to-playing handshake.  Walks phases:
   *   idle → connecting → queuing → (match found) → opening → funding → playing
   *
   * Seat A creates the on-chain tunnel and broadcasts the tunnelId; seat B waits
   * for that announcement then deposits.  Both build a DistributedTunnel from
   * endpointFactory.buildConfig once the opponent pubkey is known via partyHello.
   *
   * Any error routes to fail() — start() itself never rejects.
   */
  async start(args: { game: string; stake: bigint }): Promise<void> {
    const deps = this.startDeps;
    if (!deps) {
      this.fail(new Error("start() requires relay/endpointFactory/settlementSigner deps"));
      return;
    }
    const { relay, endpointFactory, settlementSigner } = deps;
    try {
      this.setPhase("connecting");

      // Register the match callback before queueJoin to avoid the race where
      // match.found fires during the await inside queueJoin.
      const matchPromise = new Promise<{ matchId: string; role: "A" | "B"; opponentWallet: string }>(
        (res) => relay.onMatch(res),
      );

      await relay.queueJoin(args.game);
      this.setPhase("queuing");

      const match = await matchPromise;
      const ch = relay.channel(match.matchId);

      // Exchange ephemeral pubkeys.  Broadcast first, then await peer's hello
      // (buffering in the channel handles races).
      const selfPubHex = bytesToHex(endpointFactory.self().publicKey);
      ch.partyHello(selfPubHex);

      const oppPubHex = await new Promise<string>((res) => ch.onPeerHello(res));
      const oppPubkey = hexToBytes(oppPubHex);

      // Seat A opens the tunnel; seat B waits for the announced tunnelId.
      let tunnelId: string;
      if (match.role === "A") {
        this.setPhase("opening");
        const opened = await settlementSigner.openAndFundSeatA({ stake: args.stake });
        tunnelId = opened.tunnelId;
        ch.announceOpened(tunnelId);
      } else {
        this.setPhase("opening");
        tunnelId = await new Promise<string>((res) => ch.onOpened(res));
        this.setPhase("funding");
        await settlementSigner.depositSeatB({ tunnelId, stake: args.stake });
      }

      // Seat A transitions to funding after open+fund; align phases.
      if (match.role === "A") {
        this.setPhase("funding");
      }

      // Build the DistributedTunnel from the endpoint factory config.
      const cfg = endpointFactory.buildConfig({
        tunnelId,
        selfParty: match.role,
        opponentPublicKey: oppPubkey,
        opponentAddress: match.opponentWallet,
      }) as {
        tunnelId: string;
        selfParty: "A" | "B";
        self: ReturnType<typeof core.makeEndpoint>;
        opponent: ReturnType<typeof core.makeEndpoint>;
      };

      const initialBalances = { a: args.stake, b: args.stake };
      const dt = new core.DistributedTunnel<S, M>(
        this.kit.protocol as never,
        cfg,
        ch.transport,
        initialBalances,
      );

      this.attachTunnel({ tunnel: dt as never, initialState: dt.state, transport: ch.transport });
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * Cooperative close: exchange settlement halves over the app channel, verify
   * both seats agree on the transcript root, combine into a co-signed settlement,
   * and (role A only) submit to the chain.
   *
   * Must be called after `phase === "settling"`.  Routes to `fail()` on any
   * error (root mismatch, bad signature, submit failure) so the caller does not
   * need to catch.
   */
  async settle(args: SettleArgs): Promise<void> {
    const { channel, settlementSigner, createdAt, onchainNonce } = args;
    const t = this.tunnel!;

    try {
      const root = this.transcript.root();
      const half = t.buildSettlementHalfWithRoot(createdAt, root, onchainNonce);

      const rootHex = bytesToHex(root);

      // Send our half before awaiting peer's to avoid deadlock (both sides must
      // send before either can receive).
      channel.sendSettleHalf({ sig: bytesToHex(half.sigSelf), root: rootHex });

      // Race the peer's settle-half against the timeout.  If the peer never
      // responds, escalate to a non-cooperative on-chain close.
      const peerHalf = await this.withSettleTimeout(
        new Promise<{ sig: string; root: string }>((res) => channel.onSettleHalf(res)),
        settlementSigner,
        t.tunnelId,
      );
      if (peerHalf === null) return; // timeout path already set terminal phase

      // Guard: both seats must have computed the same transcript root.
      if (peerHalf.root !== rootHex) {
        throw new Error("Transcript root mismatch between players");
      }

      const coSigned = t.combineSettlementWithRoot(
        half.settlement,
        half.sigSelf,
        hexToBytes(peerHalf.sig),
      );

      if (this.seat === "A") {
        const { digest } = await settlementSigner.submitCooperativeClose({
          tunnelId: t.tunnelId,
          coSigned,
        });
        this.clearTimers();
        const cur = this.store.get();
        this.store.set({ ...cur, phase: "done", digest, error: null });
      } else {
        this.clearTimers();
        const cur = this.store.get();
        this.store.set({ ...cur, phase: "done", error: null });
      }
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * Race a settle-half promise against the settle timeout.
   * On expiry: calls `settlementSigner.closeOnTimeout`, sets `"opponent-abandoned"`,
   * and returns `null` (the caller should return early).
   */
  private async withSettleTimeout(
    halfPromise: Promise<{ sig: string; root: string }>,
    settlementSigner: SettlementSigner,
    tunnelId: string,
  ): Promise<{ sig: string; root: string } | null> {
    let timerReject: ((e: Error) => void) | null = null;
    const timeoutPromise = new Promise<never>((_, rej) => {
      timerReject = rej;
      this.settleTimer = setTimeout(
        () => rej(new Error("__settle_timeout__")),
        this.timeouts.settleTimeoutMs,
      );
    });

    try {
      const result = await Promise.race([halfPromise, timeoutPromise]);
      // Resolved — cancel the timer.
      if (this.settleTimer !== null) {
        clearTimeout(this.settleTimer);
        this.settleTimer = null;
      }
      void timerReject; // suppress unused-variable lint
      return result;
    } catch (e) {
      if (this.settleTimer !== null) {
        clearTimeout(this.settleTimer);
        this.settleTimer = null;
      }
      if (e instanceof Error && e.message === "__settle_timeout__") {
        // Settle-half never arrived: escalate to non-cooperative close.
        try {
          await settlementSigner.closeOnTimeout({ tunnelId });
        } catch {
          // closeOnTimeout failure is swallowed — we still need to transition.
        }
        this.abandon();
        return null;
      }
      throw e;
    }
  }

  private onConfirmed(u: CoSignedUpdate): void {
    const t = this.tunnel!;
    this.transcript.append(u);

    // Deferred-confirm: call bot.confirm only when the co-signed ACK is for the
    // exact nonce we proposed, proving that OUR move was accepted.
    //
    // Nonce-match is safe for strictly-alternating kits (each seat proposes once
    // per turn, so the confirmed nonce IS our move's nonce).  For non-alternating
    // kits with concurrent proposals the opponent's accepted move could share a
    // nonce sequence — see the class-level comment on pendingNonce for details.
    if (this.pendingMove !== null && this.pendingNonce !== null) {
      if (u.update.nonce === this.pendingNonce) {
        // The ACK nonce matches: our move was accepted.
        this.clearMoveTimer();
        this.bot.confirm(t.state, this.pendingMove);
        this.pendingMove = null;
        this.pendingNonce = null;
      }
    }

    this.publish("playing", t.state);
    this.drive();
  }

  private drive(): void {
    const t = this.tunnel!;
    if (this.kit.protocol.isTerminal(t.state)) {
      this.publish("settling", t.state);
      return;
    }
    if (!this.auto) return;
    const move = this.bot.plan(t.state);
    if (move == null) return;
    try {
      // Record the expected confirmation nonce BEFORE propose() since t.nonce is
      // the last committed (ACK'd) nonce and propose() sends nonce+1.
      const expectedNonce = t.nonce + 1n;
      this.pendingMove = move;
      this.pendingNonce = expectedNonce;
      t.propose(move, BigInt(Date.now()));
      this.startMoveTimer();
    } catch (e) {
      this.pendingMove = null;
      this.pendingNonce = null;
      this.fail(e);
    }
  }

  private publish(phase: SessionPhase, state: S): void {
    const raw = this.kit.protocol.balances(state);
    const prev = this.store.get().balances;
    // Reuse the previous balances reference when the values are unchanged so that
    // SnapshotStore.sameShallow (which uses Object.is) treats a no-op publish as
    // identical and suppresses the spurious subscriber notification.
    const balances =
      prev !== null && prev.a === raw.a && prev.b === raw.b
        ? prev
        : { a: raw.a, b: raw.b };
    this.store.set({
      phase,
      state,
      balances,
      terminal: this.kit.protocol.isTerminal(state),
      error: null,
    });
  }

  /** Transition to a phase without changing state/balances (pre-playing phases). */
  private setPhase(phase: SessionPhase): void {
    const cur = this.store.get();
    this.store.set({ ...cur, phase, error: null });
  }

  private fail(e: unknown): void {
    this.clearTimers();
    const cur = this.store.get();
    this.store.set({
      ...cur,
      phase: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }

  /**
   * Transition to `"opponent-abandoned"` — fired when the transport closes or
   * errors unexpectedly, or when a move timeout expires without an ACK.
   * Uses a distinct phase (not `fail()`) so callers can differentiate a dropped
   * peer from an internal error.
   */
  private abandon(): void {
    this.clearTimers();
    const cur = this.store.get();
    // Only transition if we're in an active (non-terminal) phase.
    if (cur.phase === "done" || cur.phase === "error" || cur.phase === "opponent-abandoned") return;
    this.store.set({ ...cur, phase: "opponent-abandoned", error: null });
  }

  /** Start the move-timeout clock.  Clears any existing move timer first. */
  private startMoveTimer(): void {
    this.clearMoveTimer();
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null;
      this.abandon();
    }, this.timeouts.moveTimeoutMs);
  }

  private clearMoveTimer(): void {
    if (this.moveTimer !== null) {
      clearTimeout(this.moveTimer);
      this.moveTimer = null;
    }
  }

  /** Clear all pending timers (move + settle). */
  private clearTimers(): void {
    this.clearMoveTimer();
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }
}
