// engine-loop core; settle added in Task 5
import { core, bytesToHex, hexToBytes } from "sui-tunnel-ts";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import type { GameKit, GameBot, BotContext } from "@/agent/gameKit";
import { SnapshotStore } from "./snapshotStore";
import type {
  SessionRelay,
  PartyEndpointFactory,
  SettlementSigner,
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
}

// Minimal structural view of the engine the session drives (verified API subset).
// onConfirmed passes a CoSignedUpdate to match DistributedTunnel's actual signature.
interface TunnelLike<S, M> {
  state: S;
  latest: CoSignedUpdate | null;
  onConfirmed?: ((u: CoSignedUpdate) => void) | undefined;
  propose(move: M, timestamp: bigint): void;
}

/** Optional deps for start(): injected by fleet code, omitted in loopback tests. */
interface StartDeps {
  relay: SessionRelay;
  endpointFactory: PartyEndpointFactory;
  settlementSigner: SettlementSigner;
}

export class PvpGameSession<S, M> {
  private readonly bot: GameBot<S, M>;
  private readonly store: SnapshotStore<SessionSnapshot<S>>;
  private tunnel: TunnelLike<S, M> | null = null;
  private auto = false;
  private readonly transcript: CoSignedUpdate[] = [];
  private readonly startDeps: StartDeps | undefined;

  constructor(
    private readonly kit: GameKit<S, M>,
    private readonly seat: Party,
    ctx: BotContext,
    startDeps?: StartDeps,
  ) {
    this.bot = kit.createBot(seat, ctx);
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

  // Placeholder: real transcript root computation added in Task 5.
  transcriptRootHex(): string {
    return this.kit.stateHash(this.tunnel!.state);
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

      const backend = defaultBackend();
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

  private onConfirmed(u: CoSignedUpdate): void {
    const t = this.tunnel!;
    this.transcript.push(u);
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
      t.propose(move, BigInt(Date.now()));
      this.bot.confirm(t.state, move);
    } catch (e) {
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
