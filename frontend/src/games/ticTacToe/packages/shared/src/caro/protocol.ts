/**
 * Caro (five-in-a-row) protocols, game-side (NOT in the SDK). `CaroProtocol` is one game;
 * `MultiGameCaroProtocol` (Task 3) plays N of them in one tunnel. Both implement the SDK's
 * `Protocol` interface so they drop straight into `OffchainTunnel.selfPlay`.
 *
 * Stake is fixed at 0: the board is the only meaningful state, balances stay constant, and
 * per-game wins are tracked client-side (like the existing TicTacToe arena). encodeState uses
 * a distinct `caro.v1` domain and bakes in the board size, so a caro hash can never collide
 * with a TicTacToe hash or with a caro game of a different size.
 */

import { core, protocols } from "sui-tunnel-ts";
import { winnerAround, applyMark } from "./board";

type Protocol<State, Move> = protocols.Protocol<State, Move>;
type Party = protocols.Party;
type Balances = protocols.Balances;
type ProtocolContext = protocols.ProtocolContext;

export interface CaroState {
  board: number[]; // length size*size, values 0|1|2
  size: number; // board edge length
  turn: "A" | "B"; // side to move
  winner: number; // 0 none | 1 A | 2 B | 3 draw
  lastMove: number; // last placed index, -1 at start (UI highlight + O(1) win-check)
  movesCount: number; // placed stones; == size*size means full -> draw
  balanceA: bigint;
  balanceB: bigint;
  stake: bigint; // always 0n for caro
}

export type CaroMove = { cell: number };

const DOMAIN = protocols.protocolDomain("caro.v1");

export class CaroProtocol implements Protocol<CaroState, CaroMove> {
  readonly name = "caro.v1";
  private readonly size: number;

  /** @param boardSize edge length of the square board (the client clamps to 9–29; the
   *  protocol allows >= 3 so a 3×3 — which can never make five — is a valid draw fixture). */
  constructor(boardSize: number = 15) {
    if (!Number.isInteger(boardSize) || boardSize < 3) {
      throw new Error("caro board size must be an integer >= 3");
    }
    this.size = boardSize;
  }

  initialState(ctx: ProtocolContext): CaroState {
    return {
      board: new Array(this.size * this.size).fill(0),
      size: this.size,
      turn: "A",
      winner: 0,
      lastMove: -1,
      movesCount: 0,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      stake: 0n,
    };
  }

  applyMove(state: CaroState, move: CaroMove, by: Party): CaroState {
    if (state.winner !== 0) throw new Error("caro: game already over");
    if (by !== state.turn) throw new Error("caro: not this party's turn");
    const { cell } = move;
    if (!Number.isInteger(cell) || cell < 0 || cell >= state.size * state.size) {
      throw new Error("caro: cell out of range");
    }
    if (state.board[cell] !== 0) throw new Error("caro: cell occupied");

    const mark = by === "A" ? 1 : 2;
    const board = applyMark(state.board, cell, mark);
    const movesCount = state.movesCount + 1;
    let winner = winnerAround(board, state.size, cell);
    if (winner === 0 && movesCount === state.size * state.size) winner = 3; // draw

    return {
      ...state,
      board,
      movesCount,
      winner,
      lastMove: cell,
      turn: by === "A" ? "B" : "A",
    };
  }

  encodeState(state: CaroState): Uint8Array {
    // movesCount is intentionally NOT encoded: it is derivable from the board (count of
    // non-empty cells), so two states with the same board are already canonically distinct.
    return core.concatBytes([
      DOMAIN,
      protocols.lengthPrefixedConcat([
        core.u64ToBeBytes(state.size),
        Uint8Array.from(state.board),
        Uint8Array.from([state.turn === "A" ? 0 : 1, state.winner]),
        core.u64ToBeBytes(state.balanceA),
        core.u64ToBeBytes(state.balanceB),
        core.u64ToBeBytes(state.stake),
      ]),
    ]);
  }

  balances(state: CaroState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(state: CaroState): boolean {
    return state.winner !== 0;
  }
}

export interface MultiGameCaroState {
  inner: CaroState;
  gamesPlayed: number;
  maxGames: number;
}

export type MultiGameCaroMove = CaroMove;

const MULTI_DOMAIN = protocols.protocolDomain("caro.multi.v1");

/** Plays `maxGames` Caro games over one tunnel, composing `CaroProtocol`. */
export class MultiGameCaroProtocol
  implements Protocol<MultiGameCaroState, MultiGameCaroMove>
{
  readonly name = "caro.multi.v1";
  private readonly inner: CaroProtocol;
  private readonly maxGames: number;

  /**
   * @param maxGames  games to play in one tunnel (>= 1)
   * @param boardSize edge length passed to the inner CaroProtocol
   */
  constructor(maxGames: number, boardSize: number = 15) {
    if (!Number.isInteger(maxGames) || maxGames < 1) {
      throw new Error("maxGames must be a positive integer");
    }
    this.maxGames = maxGames;
    this.inner = new CaroProtocol(boardSize);
  }

  initialState(ctx: ProtocolContext): MultiGameCaroState {
    return { inner: this.inner.initialState(ctx), gamesPlayed: 0, maxGames: this.maxGames };
  }

  applyMove(
    state: MultiGameCaroState,
    move: MultiGameCaroMove,
    by: Party,
  ): MultiGameCaroState {
    if (!this.inner.isTerminal(state.inner)) {
      return { ...state, inner: this.inner.applyMove(state.inner, move, by) };
    }
    if (this.isTerminal(state)) {
      throw new Error("caro session over: no more games can be played");
    }
    // Reset to a fresh board, carrying balances forward (stake is 0, so they are unchanged).
    const carried = this.inner.initialState({
      tunnelId: "",
      initialBalances: { a: state.inner.balanceA, b: state.inner.balanceB },
    });
    return { inner: carried, gamesPlayed: state.gamesPlayed + 1, maxGames: state.maxGames };
  }

  encodeState(state: MultiGameCaroState): Uint8Array {
    return core.concatBytes([
      MULTI_DOMAIN,
      protocols.lengthPrefixedConcat([
        this.inner.encodeState(state.inner),
        core.u64ToBeBytes(state.gamesPlayed),
      ]),
    ]);
  }

  balances(state: MultiGameCaroState): Balances {
    return this.inner.balances(state.inner);
  }

  isTerminal(state: MultiGameCaroState): boolean {
    if (!this.inner.isTerminal(state.inner)) return false;
    return state.gamesPlayed + 1 >= state.maxGames;
  }

  randomMove(
    state: MultiGameCaroState,
    by: Party,
    _rng: () => number,
  ): MultiGameCaroMove | null {
    if (this.isTerminal(state)) return null;
    // Between games only A drives the advance (mirrors TTT); mid-game the hook supplies moves.
    if (this.inner.isTerminal(state.inner)) return by === "A" ? { cell: 0 } : null;
    // Mid-game fallback: first empty cell (the real bot uses caro/bot.ts instead).
    const i = state.inner.board.findIndex((c) => c === 0);
    return i >= 0 ? { cell: i } : null;
  }
}
