/**
 * Caro / Gomoku protocol: a two-party staked grid game over a tunnel, generalized so the
 * SAME engine covers classic Tic-Tac-Toe (3x3, 3-in-a-row) and Caro/Gomoku (e.g. 15x15,
 * 5-in-a-row). Party A plays mark 1, party B mark 2.
 *
 * Unlike a single-shot game, this protocol plays MANY matches back-to-back inside one tunnel
 * (mirroring the Blackjack protocol's round loop): when a match ends, the board resets and a
 * fresh match begins — with the starting player alternating for fairness — until `matchCap`
 * matches have been played (or a party can no longer cover the stake). This multi-match loop
 * is what amortizes the two on-chain transactions (open + cooperative close) over a large
 * number of off-chain, dual-signed state transitions: the throughput point of the framework.
 *
 * Settlement: each decisive match shifts `stake` from loser to winner (clamped to the loser's
 * balance, so balances never go negative and always sum to the locked total); a draw shifts
 * nothing. Every state is co-signed, so the latest agreed state is always settleable on-chain.
 *
 * Constants/types are CARO_-prefixed to avoid colliding with ticTacToe.ts under the protocol
 * barrel's `export *`.
 */

import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
} from "./Protocol";
import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";

/** Cell / mark values. 0 = empty, 1 = A, 2 = B. */
export const CARO_EMPTY = 0;
export const CARO_MARK_A = 1;
export const CARO_MARK_B = 2;

/** Last-match outcome code: 0 none/in-progress, 1 A won, 2 B won, 3 draw. */
export type CaroWinner = 0 | 1 | 2 | 3;

export type CaroPhase = "playing" | "over";

export interface CaroState {
  /** boardSize*boardSize cells, row-major: 0 empty, 1 = A, 2 = B. */
  board: number[];
  /** In "playing", whose mark is next. In "over", the starter of the next match. */
  turn: Party;
  /** Marks placed in the CURRENT match (0..boardSize^2). */
  moves: number;
  phase: CaroPhase;
  /** Number of COMPLETED matches; also selects the next match's starter. */
  matchesPlayed: number;
  /** Outcome of the most recently completed match (0 while a match is in progress). */
  lastWinner: CaroWinner;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
  /** Amount shifted from loser to winner per decisive match. */
  stake: bigint;
}

export interface CaroMove {
  /** Target cell index, 0..boardSize^2-1. In "over" phase this is the first move of a fresh board. */
  cell: number;
}

/** Standard presets. Tic-Tac-Toe is just the 3x3 / 3-in-a-row special case of Caro. */
export const CARO_PRESETS = {
  ttt: { boardSize: 3, winLength: 3 },
  caro: { boardSize: 15, winLength: 5 },
} as const;

/** Which party starts match number `matchesPlayed` (0-based). Alternates for fairness. */
export function caroStarterFor(matchesPlayed: number): Party {
  return matchesPlayed % 2 === 0 ? "A" : "B";
}

/** Who must move next, accounting for the between-matches "over" phase. */
export function caroNextMover(state: CaroState): Party {
  return state.phase === "over" ? caroStarterFor(state.matchesPlayed) : state.turn;
}

/** Empty cells available to the mover: the fresh full board in "over", else current empties. */
export function caroCandidateCells(state: CaroState, boardSize: number): number[] {
  const n = boardSize * boardSize;
  if (state.phase === "over") return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (state.board[i] === CARO_EMPTY) out.push(i);
  return out;
}

export class CaroProtocol implements Protocol<CaroState, CaroMove> {
  readonly name: string;
  readonly boardSize: number;
  readonly winLength: number;
  /** Matches to play before the game is forced terminal. */
  readonly matchCap: number;
  private readonly defaultStake: bigint;

  constructor(opts?: {
    boardSize?: number;
    winLength?: number;
    matchCap?: number;
    stake?: bigint;
  }) {
    this.boardSize = opts?.boardSize ?? CARO_PRESETS.caro.boardSize;
    this.winLength = opts?.winLength ?? CARO_PRESETS.caro.winLength;
    this.matchCap = opts?.matchCap ?? 100;
    this.defaultStake = opts?.stake ?? 100n;
    if (this.boardSize < 1) throw new Error("boardSize must be >= 1");
    if (this.winLength < 1 || this.winLength > this.boardSize)
      throw new Error("winLength must be in 1..boardSize");
    if (this.matchCap < 1) throw new Error("matchCap must be >= 1");
    if (this.defaultStake < 0n) throw new Error("stake must be non-negative");
    this.name = `caro.v1.${this.boardSize}x${this.boardSize}k${this.winLength}`;
  }

  private get cellCount(): number {
    return this.boardSize * this.boardSize;
  }

  initialState(ctx: ProtocolContext): CaroState {
    const total = ctx.initialBalances.a + ctx.initialBalances.b;
    const cap =
      ctx.initialBalances.a < ctx.initialBalances.b
        ? ctx.initialBalances.a
        : ctx.initialBalances.b;
    const stake = this.defaultStake < cap ? this.defaultStake : cap;
    return {
      board: new Array(this.cellCount).fill(CARO_EMPTY),
      turn: caroStarterFor(0),
      moves: 0,
      phase: "playing",
      matchesPlayed: 0,
      lastWinner: 0,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total,
      stake,
    };
  }

  applyMove(state: CaroState, move: CaroMove, by: Party): CaroState {
    if (this.isTerminal(state)) throw new Error("game over: matchCap reached or stake unfundable");
    const { cell } = move;
    if (!Number.isInteger(cell) || cell < 0 || cell >= this.cellCount) {
      throw new Error(`cell out of range: ${cell}`);
    }

    if (state.phase === "over") {
      // Start a fresh match: reset the board and place the first mark.
      const starter = caroStarterFor(state.matchesPlayed);
      if (by !== starter) throw new Error(`match ${state.matchesPlayed} starts with ${starter}`);
      const board = new Array(this.cellCount).fill(CARO_EMPTY);
      board[cell] = by === "A" ? CARO_MARK_A : CARO_MARK_B;
      return this.resolveAfterPlace(state, board, cell, 1, by);
    }

    // phase "playing"
    if (by !== state.turn) throw new Error(`not ${by}'s turn`);
    if (state.board[cell] !== CARO_EMPTY) throw new Error(`cell ${cell} occupied`);
    const board = state.board.slice();
    board[cell] = by === "A" ? CARO_MARK_A : CARO_MARK_B;
    return this.resolveAfterPlace(state, board, cell, state.moves + 1, by);
  }

  /** Shared tail for both "playing" and match-restart placements. */
  private resolveAfterPlace(
    prev: CaroState,
    board: number[],
    lastCell: number,
    moves: number,
    by: Party,
  ): CaroState {
    const win = this.winnerFrom(board, lastCell, moves);
    if (win === 0) {
      // Match continues; hand the turn to the other party.
      return {
        ...prev,
        board,
        turn: by === "A" ? "B" : "A",
        moves,
        phase: "playing",
        lastWinner: 0,
      };
    }
    // Match ended (decisive or draw): settle and move to the between-matches phase.
    let { balanceA, balanceB } = prev;
    if (win === 1 || win === 2) {
      const loserBal = win === 1 ? balanceB : balanceA;
      const shift = prev.stake < loserBal ? prev.stake : loserBal;
      if (win === 1) {
        balanceA += shift;
        balanceB -= shift;
      } else {
        balanceA -= shift;
        balanceB += shift;
      }
    }
    const matchesPlayed = prev.matchesPlayed + 1;
    return {
      ...prev,
      board,
      moves,
      phase: "over",
      matchesPlayed,
      lastWinner: win,
      balanceA,
      balanceB,
      // Park `turn` on the next match's starter so encodeState stays canonical.
      turn: caroStarterFor(matchesPlayed),
    };
  }

  encodeState(state: CaroState): Uint8Array {
    return concatBytes([
      domainFor(this.boardSize, this.winLength),
      Uint8Array.from(state.board),
      Uint8Array.of(
        state.turn === "A" ? 0 : 1,
        state.phase === "playing" ? 0 : 1,
        state.lastWinner,
      ),
      u64ToBeBytes(BigInt(state.moves)),
      u64ToBeBytes(BigInt(state.matchesPlayed)),
      u64ToBeBytes(state.balanceA),
      u64ToBeBytes(state.balanceB),
      u64ToBeBytes(state.stake),
    ]);
  }

  balances(state: CaroState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(state: CaroState): boolean {
    if (state.phase !== "over") return false; // never terminal mid-match
    if (state.matchesPlayed >= this.matchCap) return true;
    return !(state.balanceA >= state.stake && state.balanceB >= state.stake);
  }

  randomMove(state: CaroState, by: Party, rng: () => number): CaroMove | null {
    if (this.isTerminal(state)) return null;
    if (by !== caroNextMover(state)) return null;
    const cands = caroCandidateCells(state, this.boardSize);
    if (cands.length === 0) return null;
    const i = Math.floor(rng() * cands.length);
    return { cell: cands[i < cands.length ? i : cands.length - 1] };
  }

  /**
   * Winner from the just-placed cell only: the placed mark is the only one that can have
   * completed a line, so we scan the 4 axes through `lastCell` for `winLength` in a row.
   * Returns 1/2 for a win, 3 for a full-board draw, else 0. O(winLength).
   */
  private winnerFrom(board: number[], lastCell: number, moves: number): CaroWinner {
    const n = this.boardSize;
    const mark = board[lastCell];
    if (mark === CARO_EMPTY) return 0;
    const r = Math.floor(lastCell / n);
    const c = lastCell % n;
    const dirs = [
      [0, 1], // horizontal
      [1, 0], // vertical
      [1, 1], // diagonal ↘
      [1, -1], // diagonal ↙
    ];
    for (const [dr, dc] of dirs) {
      let count = 1;
      for (let s = 1; s < this.winLength; s++) {
        const rr = r + dr * s;
        const cc = c + dc * s;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n || board[rr * n + cc] !== mark) break;
        count++;
      }
      for (let s = 1; s < this.winLength; s++) {
        const rr = r - dr * s;
        const cc = c - dc * s;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n || board[rr * n + cc] !== mark) break;
        count++;
      }
      if (count >= this.winLength) return mark as CaroWinner;
    }
    return moves >= this.cellCount ? 3 : 0;
  }
}

/** Domain separator scoped to the board geometry so different sizes can't collide. */
function domainFor(boardSize: number, winLength: number): Uint8Array {
  return protocolDomain(`caro.v1.${boardSize}x${boardSize}k${winLength}`);
}
