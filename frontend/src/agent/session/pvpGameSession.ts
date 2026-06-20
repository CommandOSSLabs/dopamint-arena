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
  private auto = false;
  private readonly transcript: Transcript;
  private readonly startDeps: StartDeps | undefined;

  // Deferred-confirm state: track the move we proposed so we can confirm it
  // after the co-signed ACK arrives (i.e. the state actually advanced).
  private pendingMove: M | null = null;
  private pendingPreHash: string | null = null;

  constructor(
    private readonly kit: GameKit<S, M>,
    private readonly seat: Party,
    ctx: BotContext,
    startDeps?: StartDeps,
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
  }

  // Test/Task-4 seam: inject a ready tunnel + seeded state.
  attachTunnel(deps: { tunnel: TunnelLike<S, M>; initialState: S }): void {
    this.tunnel = deps.tunnel;
    // Re-initialise the Transcript with the real tunnelId now that it's known.
    // Cast to access the private field — the Transcript has no reset(), so we
    // replace it via Object.assign on the prototype-transparent property.
    (this as unknown as { transcript: Transcript }).transcript = new Transcript(
      deps.tunnel.tunnelId,
    );
    this.tunnel.onConfirmed = (u: CoSignedUpdate) => this.onConfirmed(u);
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

      this.attachTunnel({ tunnel: dt as never, initialState: dt.state });
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

      const peerHalf = await new Promise<{ sig: string; root: string }>((res) =>
        channel.onSettleHalf(res),
      );

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
        const cur = this.store.get();
        this.store.set({ ...cur, phase: "done", digest, error: null });
      } else {
        const cur = this.store.get();
        this.store.set({ ...cur, phase: "done", error: null });
      }
    } catch (e) {
      this.fail(e);
    }
  }

  private onConfirmed(u: CoSignedUpdate): void {
    const t = this.tunnel!;
    this.transcript.append(u);

    // Deferred-confirm: call bot.confirm only after our proposed move is actually
    // accepted (the co-signed ACK arrives), not immediately after propose().
    if (this.pendingMove !== null && this.pendingPreHash !== null) {
      const currentHash = this.kit.stateHash(t.state);
      if (currentHash !== this.pendingPreHash) {
        // State advanced — our move was accepted.
        this.bot.confirm(t.state, this.pendingMove);
        this.pendingMove = null;
        this.pendingPreHash = null;
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
      // Record the pre-proposal state hash so onConfirmed can detect when our
      // move is accepted and call bot.confirm with the POST-move confirmed state.
      this.pendingPreHash = this.kit.stateHash(t.state);
      this.pendingMove = move;
      t.propose(move, BigInt(Date.now()));
    } catch (e) {
      this.pendingMove = null;
      this.pendingPreHash = null;
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
    const cur = this.store.get();
    this.store.set({
      ...cur,
      phase: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
