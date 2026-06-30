/**
 * Tic-Tac-Toe protocol: a two-party staked game over a tunnel.
 *
 * Party A plays mark X (1) and moves first; party B plays mark O (2). Each move
 * places a mark in an empty cell; the engine co-signs the resulting board so the
 * agreed state is always settleable. On a terminal outcome `stake` shifts from the
 * loser to the winner (clamped to the loser's available balance); a draw leaves
 * balances unchanged. Balances therefore always sum to the locked total.
 *
 * This is the pure off-chain analog of `example_tic_tac_toe.move`; win detection
 * mirrors that module's `check_winner`.
 *
 * v2 adds a 32-byte `moveAccumulator` to the co-signed state. Each move folds a
 * salted commitment (`computeCommitment(mover||moveIndex||cell, salt)`) into the
 * accumulator so the full move history is unforgeable without replaying every move.
 */

import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
} from "./Protocol";
import { concatBytes } from "../core/bytes";
import { blake2b256 } from "../core/crypto";
import { u64ToBeBytes } from "../core/wire";
import {
  computeCommitment,
  DOMAIN_COMMIT_REVEAL,
  MIN_SALT_LEN,
} from "../core/commitment";

/** Cell / mark values. 0 = empty, 1 = A (X), 2 = B (O). */
export const EMPTY = 0;
export const MARK_A = 1;
export const MARK_B = 2;

/** Winner codes: 0 none, 1 A, 2 B, 3 draw. */
export type Winner = 0 | 1 | 2 | 3;

export interface TicTacToeState {
  /** 9-cell board, row-major: 0 empty, 1 = A/X, 2 = B/O. */
  board: number[];
  /** Whose turn it is to place a mark. A always moves first. */
  turn: Party;
  /** Number of marks placed so far (0..9). */
  movesCount: number;
  /** 0 none, 1 A, 2 B, 3 draw. */
  winner: Winner;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
  /** Amount shifted from loser to winner on a decisive result. */
  stake: bigint;
  /**
   * 32-byte running commitment accumulator. Initialized from the v2 protocol domain;
   * each move folds in `computeCommitment(mover||moveIndex||cell, salt)` so the full
   * move history is unforgeable and auditable without re-replaying every move.
   */
  moveAccumulator: Uint8Array;
}

export interface TicTacToeMove {
  /** Target cell index, 0..8. */
  cell: number;
  /** Per-move salt, >= 16 bytes (enforced by computeCommitment). */
  salt: Uint8Array;
}

const DOMAIN = protocolDomain("tic_tac_toe.v2");

/** `lp(x) = u64be(len(x)) || x` — length-prefixed chunk for the accumulator hash. */
function lp(x: Uint8Array): Uint8Array[] {
  return [u64ToBeBytes(x.length), x];
}

/** Initial accumulator value seeded from the v2 protocol domain. */
function initialAccumulator(): Uint8Array {
  return blake2b256(concatBytes([DOMAIN_COMMIT_REVEAL, ...lp(DOMAIN)]));
}

/** Fold one commitment into the running accumulator. */
function advanceAccumulator(
  prevAcc: Uint8Array,
  commitment: Uint8Array
): Uint8Array {
  return blake2b256(
    concatBytes([DOMAIN_COMMIT_REVEAL, ...lp(prevAcc), ...lp(commitment)])
  );
}

/** The 8 winning lines (rows, columns, diagonals). */
const LINES: readonly [number, number, number][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

/**
 * Detect a winner on `board`. Returns 0 (none), 1 (A/X), 2 (B/O), or 3 (draw).
 * Mirrors `example_tic_tac_toe::check_winner`.
 */
function checkWinner(board: number[], movesCount: number): Winner {
  for (const [x, y, z] of LINES) {
    const v = board[x];
    if (v !== EMPTY && v === board[y] && v === board[z]) {
      return v as Winner;
    }
  }
  if (movesCount === 9) return 3;
  return 0;
}

export class TicTacToeProtocol
  implements Protocol<TicTacToeState, TicTacToeMove>
{
  readonly name = "tic_tac_toe.v2";

  /** Default stake used when the caller does not configure one. */
  private readonly defaultStake: bigint;

  constructor(stake: bigint = 100n) {
    if (stake < 0n) throw new Error("stake must be non-negative");
    this.defaultStake = stake;
  }

  initialState(ctx: ProtocolContext): TicTacToeState {
    const total = ctx.initialBalances.a + ctx.initialBalances.b;
    // Stake cannot exceed what either party can actually lose.
    const cap =
      ctx.initialBalances.a < ctx.initialBalances.b
        ? ctx.initialBalances.a
        : ctx.initialBalances.b;
    const stake = this.defaultStake < cap ? this.defaultStake : cap;
    return {
      board: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      turn: "A",
      movesCount: 0,
      winner: 0,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total,
      stake,
      moveAccumulator: initialAccumulator(),
    };
  }

  applyMove(
    state: TicTacToeState,
    move: TicTacToeMove,
    by: Party
  ): TicTacToeState {
    if (state.winner !== 0) throw new Error("game already over");
    if (by !== state.turn) throw new Error(`not ${by}'s turn`);
    const { cell, salt } = move;
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) {
      throw new Error(`cell out of range: ${cell}`);
    }
    if (state.board[cell] !== EMPTY) throw new Error(`cell ${cell} occupied`);
    // salt length validated by computeCommitment (>= MIN_SALT_LEN)
    if (!salt || salt.length < MIN_SALT_LEN) {
      throw new Error(`salt must be >= ${MIN_SALT_LEN} bytes`);
    }

    const board = state.board.slice();
    board[cell] = by === "A" ? MARK_A : MARK_B;
    const movesCount = state.movesCount + 1;
    const winner = checkWinner(board, movesCount);

    let balanceA = state.balanceA;
    let balanceB = state.balanceB;
    if (winner === 1 || winner === 2) {
      // Loser pays `stake` to winner, clamped to the loser's balance.
      const loserBal = winner === 1 ? state.balanceB : state.balanceA;
      const shift = state.stake < loserBal ? state.stake : loserBal;
      if (winner === 1) {
        balanceA = state.balanceA + shift;
        balanceB = state.balanceB - shift;
      } else {
        balanceA = state.balanceA - shift;
        balanceB = state.balanceB + shift;
      }
    }
    // winner === 3 (draw) or 0 (ongoing): balances unchanged.

    // Fold the salted commitment into the accumulator.
    // value = u8(mover) || u64be(moveIndex) || u64be(cell)
    // mover: 1 for A, 2 for B; moveIndex = movesCount after increment (the first placed mark = 1).
    const moverByte = by === "A" ? 1 : 2;
    const value = concatBytes([
      Uint8Array.of(moverByte),
      u64ToBeBytes(movesCount),
      u64ToBeBytes(cell),
    ]);
    const commitment = computeCommitment(value, salt);
    const moveAccumulator = advanceAccumulator(state.moveAccumulator, commitment);

    return {
      board,
      turn: by === "A" ? "B" : "A",
      movesCount,
      winner,
      balanceA,
      balanceB,
      total: state.total,
      stake: state.stake,
      moveAccumulator,
    };
  }

  encodeState(state: TicTacToeState): Uint8Array {
    // Board is fixed-length (9), so a flat byte run is unambiguous; the trailing
    // fixed-width fields keep the whole encoding canonical and collision-free.
    // The 32-byte moveAccumulator is appended last so v1 and v2 are distinguishable
    // by domain and by length.
    const board = Uint8Array.from(state.board);
    return concatBytes([
      DOMAIN,
      board,
      Uint8Array.of(state.movesCount, state.winner, state.turn === "A" ? 0 : 1),
      u64ToBeBytes(state.balanceA),
      u64ToBeBytes(state.balanceB),
      u64ToBeBytes(state.stake),
      state.moveAccumulator,
    ]);
  }

  balances(state: TicTacToeState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(state: TicTacToeState): boolean {
    return state.winner !== 0;
  }

  randomMove(
    state: TicTacToeState,
    by: Party,
    rng: () => number
  ): TicTacToeMove | null {
    if (state.winner !== 0 || by !== state.turn) return null;
    const empties: number[] = [];
    for (let i = 0; i < 9; i++) {
      if (state.board[i] === EMPTY) empties.push(i);
    }
    if (empties.length === 0) return null;
    const idx = Math.floor(rng() * empties.length);
    // Guard against rng() returning exactly 1 (out of spec but defensive).
    const cell = empties[idx < empties.length ? idx : empties.length - 1];
    // Derive a 16-byte deterministic salt from the rng so randomMove stays idempotent
    // given the same rng sequence. rng() returns floats in [0,1); pack two per u64be.
    const saltBytes = new Uint8Array(16);
    const saltView = new DataView(saltBytes.buffer);
    saltView.setFloat64(0, rng(), false);
    saltView.setFloat64(8, rng(), false);
    return { cell, salt: saltBytes };
  }
}
