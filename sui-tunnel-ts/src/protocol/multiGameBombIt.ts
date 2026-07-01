/**
 * Multi-game Bomb It: fight MANY duels inside ONE tunnel, settle ONCE on demand.
 * Composes the single-game {@link BombItProtocol}; the exact mirror of
 * MultiGameCrossProtocol.
 *
 * Balance model (ADR 0011): BombItProtocol is winner-takes-all, so the wrapper OWNS the
 * real carried balances and swaps a fixed `stakePerGame` loser→winner per DECIDED duel;
 * the inner duel runs with symbolic per-game balances purely to crown a winner. bomb-it's
 * winner is "A" | "B" | "draw" | null — both "draw" and null swap nothing (played but
 * unscored, fundable-next). Per-game seed `${tunnelId}:g${N}` differs each duel's grid
 * (deterministic, public, symmetric — no commit-reveal, per ADR 0010).
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
  BombItProtocol,
  BOMB_IT_MIN_STAKE,
  type BombItState,
  type BombItMove,
} from "./bombIt";
import { canSafelyPlayNextEpisode } from "../proof/limits";

/** A very conservative upper bound on moves per Bomb It game */
const BOMB_IT_MAX_MOVES_PER_GAME = 1000;

export interface MultiGameBombItState {
  inner: BombItState;
  gamesPlayed: number;
  balanceA: bigint;
  balanceB: bigint;
  totalMoves: number;
}

export type MultiGameBombItMove = BombItMove;

export class MultiGameBombItProtocol
  implements Protocol<MultiGameBombItState, MultiGameBombItMove>
{
  readonly name = "bomb_it.multi.v1";

  private readonly domain = protocolDomain("bomb_it.multi.v1");
  private readonly inner = new BombItProtocol();

  constructor(
    private readonly tunnelId: string,
    private readonly stakePerGame: bigint = BOMB_IT_MIN_STAKE
  ) {}

  private gameCtx(gameNumber: number): ProtocolContext {
    return {
      tunnelId: `${this.tunnelId}:g${gameNumber}`,
      initialBalances: { a: this.stakePerGame, b: this.stakePerGame },
    };
  }

  initialState(ctx: ProtocolContext): MultiGameBombItState {
    return {
      inner: this.inner.initialState(this.gameCtx(1)),
      gamesPlayed: 0,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      totalMoves: 0,
    };
  }

  isGameOver(state: MultiGameBombItState): boolean {
    return this.inner.isTerminal(state.inner);
  }

  applyMove(
    state: MultiGameBombItState,
    move: MultiGameBombItMove,
    by: Party
  ): MultiGameBombItState {
    if (!this.inner.isTerminal(state.inner)) {
      const nextInner = this.inner.applyMove(state.inner, move, by);
      if (this.inner.isTerminal(nextInner)) {
        const swapped = this.swap(
          state.balanceA,
          state.balanceB,
          nextInner.winner
        );
        return {
          inner: nextInner,
          gamesPlayed: state.gamesPlayed,
          balanceA: swapped.a,
          balanceB: swapped.b,
          totalMoves: state.totalMoves + 1,
        };
      }
      return { ...state, inner: nextInner, totalMoves: state.totalMoves + 1 };
    }
    if (this.isTerminal(state)) {
      throw new Error("session over: insufficient balance for another game");
    }
    const fresh = this.inner.initialState(this.gameCtx(state.gamesPlayed + 2));
    return {
      inner: this.inner.applyMove(fresh, move, by),
      gamesPlayed: state.gamesPlayed + 1,
      balanceA: state.balanceA,
      balanceB: state.balanceB,
      totalMoves: state.totalMoves + 1,
    };
  }

  /** Swap stakePerGame loser→winner; "draw" and null swap nothing. */
  private swap(
    a: bigint,
    b: bigint,
    winner: BombItState["winner"]
  ): { a: bigint; b: bigint } {
    if (winner === "A")
      return { a: a + this.stakePerGame, b: b - this.stakePerGame };
    if (winner === "B")
      return { a: a - this.stakePerGame, b: b + this.stakePerGame };
    return { a, b }; // "draw" | null
  }

  encodeState(state: MultiGameBombItState): Uint8Array {
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

  balances(state: MultiGameBombItState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(state: MultiGameBombItState): boolean {
    if (!this.inner.isTerminal(state.inner)) return false;
    if (!this.canFundNextGame(state)) return true;
    return !canSafelyPlayNextEpisode(state.totalMoves, BOMB_IT_MAX_MOVES_PER_GAME);
  }

  randomMove(
    state: MultiGameBombItState,
    by: Party,
    rng: () => number
  ): MultiGameBombItMove | null {
    if (!this.inner.isTerminal(state.inner))
      return this.inner.randomMove(state.inner, by, rng);
    return null;
  }

  private canFundNextGame(state: MultiGameBombItState): boolean {
    if (this.stakePerGame === 0n) return true;
    return (
      state.balanceA >= this.stakePerGame && state.balanceB >= this.stakePerGame
    );
  }
}
