// engine-loop core; start()/settle added in Tasks 4-5
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import type { GameKit, GameBot, BotContext } from "@/agent/gameKit";
import { SnapshotStore } from "./snapshotStore";

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

export class PvpGameSession<S, M> {
  private readonly bot: GameBot<S, M>;
  private readonly store: SnapshotStore<SessionSnapshot<S>>;
  private tunnel: TunnelLike<S, M> | null = null;
  private auto = false;
  private readonly transcript: CoSignedUpdate[] = [];

  constructor(
    private readonly kit: GameKit<S, M>,
    private readonly seat: Party,
    ctx: BotContext,
  ) {
    this.bot = kit.createBot(seat, ctx);
    this.store = new SnapshotStore<SessionSnapshot<S>>({
      phase: "idle",
      state: null,
      balances: null,
      terminal: false,
      error: null,
    });
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

  private fail(e: unknown): void {
    const cur = this.store.get();
    this.store.set({
      ...cur,
      phase: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
