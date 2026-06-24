/**
 * Multi-game Chicken Cross: race MANY times inside ONE tunnel, settle ONCE on demand.
 * Composes the single-game {@link CrossProtocol}.
 *
 * Balance model (ADR 0011): CrossProtocol is winner-takes-all, which would exhaust a
 * seat after one decisive race. So this wrapper does NOT delegate balances — it owns
 * the real carried balances and swaps a fixed `stakePerGame` loser→winner per decided
 * race (a push swaps nothing), exactly like battleship's small-stake/large-balance
 * multi-game. Each inner race runs with symbolic per-game balances purely to crown a
 * winner. Per-game seed `${tunnelId}:g${N}` gives every race a different hazard field
 * (deterministic, public, party-independent — no commit-reveal, per ADR 0010).
 */
import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
  lengthPrefixedConcat,
} from "./Protocol";
import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";
import {
  CrossProtocol,
  MIN_STAKE,
  type CrossState,
  type CrossMove,
} from "./cross";

export interface MultiGameCrossState {
  /** The current single race (positions, scores). Its balances are symbolic per-game. */
  inner: CrossState;
  /** Completed games behind the current one; the running game is `gamesPlayed + 1`. */
  gamesPlayed: number;
  /** REAL carried balance for seat A; balanceA + balanceB === the locked total. */
  balanceA: bigint;
  /** REAL carried balance for seat B. */
  balanceB: bigint;
}

/** A move is a normal inner move; the first one after a game ends starts the next. */
export type MultiGameCrossMove = CrossMove;

export class MultiGameCrossProtocol implements Protocol<
  MultiGameCrossState,
  MultiGameCrossMove
> {
  readonly name = "cross.multi.v1";

  private readonly domain = protocolDomain("cross.multi.v1");
  private readonly inner = new CrossProtocol();

  /**
   * @param tunnelId real Sui tunnel id; per-game seeds derive from `${tunnelId}:g${N}`.
   * @param stakePerGame amount swapped loser→winner per decided race (and the floor each
   *        side must still hold to fund another). Small vs the funded balance ⇒ many games.
   */
  constructor(
    private readonly tunnelId: string,
    private readonly stakePerGame: bigint = MIN_STAKE,
  ) {}

  /** Inner race ctx: symbolic per-game balances; per-game seed from the synthetic id. */
  private gameCtx(gameNumber: number): ProtocolContext {
    return {
      tunnelId: `${this.tunnelId}:g${gameNumber}`,
      initialBalances: { a: this.stakePerGame, b: this.stakePerGame },
    };
  }

  initialState(ctx: ProtocolContext): MultiGameCrossState {
    return {
      inner: this.inner.initialState(this.gameCtx(1)),
      gamesPlayed: 0,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
    };
  }

  /** Whether the CURRENT inner race is over, regardless of session funding. */
  isGameOver(state: MultiGameCrossState): boolean {
    return this.inner.isTerminal(state.inner);
  }

  applyMove(
    state: MultiGameCrossState,
    move: MultiGameCrossMove,
    by: Party,
  ): MultiGameCrossState {
    // Mid-race: delegate to the inner protocol (throws on an illegal move). If this move
    // DECIDES the race, swap the real per-game stake loser→winner on the carried balances.
    if (!this.inner.isTerminal(state.inner)) {
      const nextInner = this.inner.applyMove(state.inner, move, by);
      if (this.inner.isTerminal(nextInner)) {
        const swapped = this.swap(
          state.balanceA,
          state.balanceB,
          nextInner.winner,
        );
        return {
          inner: nextInner,
          gamesPlayed: state.gamesPlayed,
          balanceA: swapped.a,
          balanceB: swapped.b,
        };
      }
      return { ...state, inner: nextInner };
    }
    // The race finished. If neither side can fund the next stake, only settlement remains.
    if (this.isTerminal(state)) {
      throw new Error("session over: insufficient balance for another game");
    }
    // This move STARTS the next race: reset the inner game (new per-game seed), carry the
    // real balances unchanged (the swap already happened on the deciding move), bump count.
    // The kickoff move IS game N's first competitive tick — the new race starts at tick 1.
    const fresh = this.inner.initialState(this.gameCtx(state.gamesPlayed + 2));
    return {
      inner: this.inner.applyMove(fresh, move, by),
      gamesPlayed: state.gamesPlayed + 1,
      balanceA: state.balanceA,
      balanceB: state.balanceB,
    };
  }

  /** Move stakePerGame loser→winner; a push (null winner) leaves balances unchanged. */
  private swap(
    a: bigint,
    b: bigint,
    winner: CrossState["winner"],
  ): { a: bigint; b: bigint } {
    if (winner === "A")
      return { a: a + this.stakePerGame, b: b - this.stakePerGame };
    if (winner === "B")
      return { a: a - this.stakePerGame, b: b + this.stakePerGame };
    return { a, b };
  }

  encodeState(state: MultiGameCrossState): Uint8Array {
    return concatBytes([
      this.domain,
      lengthPrefixedConcat([
        this.inner.encodeState(state.inner),
        u64ToBeBytes(BigInt(state.gamesPlayed)),
        u64ToBeBytes(state.balanceA),
        u64ToBeBytes(state.balanceB),
      ]),
    ]);
  }

  balances(state: MultiGameCrossState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(state: MultiGameCrossState): boolean {
    if (!this.inner.isTerminal(state.inner)) return false; // settlement is player-driven mid-game
    return !this.canFundNextGame(state); // between games: terminal only at exhaustion
  }

  randomMove(
    state: MultiGameCrossState,
    by: Party,
    rng: () => number,
  ): MultiGameCrossMove | null {
    // Mid-race defer to the inner bot. Between games return null — the session decides
    // whether to rematch (a kickoff move) or settle; the simulator never auto-rematches.
    if (!this.inner.isTerminal(state.inner))
      return this.inner.randomMove(state.inner, by, rng);
    return null;
  }

  private canFundNextGame(state: MultiGameCrossState): boolean {
    if (this.stakePerGame === 0n) return true;
    return (
      state.balanceA >= this.stakePerGame && state.balanceB >= this.stakePerGame
    );
  }
}
