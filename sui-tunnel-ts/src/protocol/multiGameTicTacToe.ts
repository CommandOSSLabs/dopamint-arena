/**
 * Multi-Game Tic-Tac-Toe: MANY staked games over a SINGLE tunnel, settled once.
 *
 * This is the off-chain analog of `example_multi_game_tictactoe.move`. It plays an
 * unbounded (or `targetGames`-capped) sequence of tic-tac-toe games inside one
 * `OffchainTunnel`, maintaining a RUNNING balance and a cumulative scoreboard. A
 * move that completes a game folds the result immediately: `wager` shifts from the
 * loser to the winner (clamped to the loser's balance), the scoreboard updates, and
 * the board resets to empty for the next game — so balances always sum to the locked
 * total and the cumulative result of all games is just the final running balances,
 * settled in ONE `close_cooperative`.
 *
 * It is the same composition pattern as Blackjack (round 0..ROUND_CAP) and Quantum
 * Poker (handNo/handCap): a single `Protocol<State, Move>` whose `isTerminal` is
 * driven by a session cap, not by one game ending. The off-chain engine
 * (core/tunnel.ts), its single monotonic nonce, the canonical state_update wire
 * format, and on-chain settlement are all reused UNCHANGED.
 *
 * ## On-chain wire compatibility (load-bearing)
 * `encodeState` reproduces, byte-for-byte, the Move
 * `example_multi_game_tictactoe::compute_session_hash_with_id` layout:
 *
 *   b"multi_tic_tac_toe::session" || tunnelId(32) || board(9) || movesCount(1)
 *     || u64be(gamesPlayed) || u64be(winsA) || u64be(winsB) || u64be(draws)
 *     || u64be(balanceA) || u64be(balanceB)
 *
 * The engine hashes this with blake2b256 into the opaque 32-byte `state_hash` of the
 * CORE `sui_tunnel::state_update` message both parties sign. Because the Move wrapper
 * recomputes the SAME hash, an off-chain-signed session update is enforceable on-chain
 * in a dispute. The nonce is intentionally NOT part of this hash — it is bound (and
 * checked strictly increasing) by the core state_update message instead, and the
 * engine assigns it after `encodeState` runs.
 */

import { concatBytes } from "../core/bytes";
import { addressToBytes32, u64ToBeBytes } from "../core/wire";
import { Balances, Party, Protocol, ProtocolContext } from "./Protocol";
import { TicTacToeMove, Winner } from "./ticTacToe";

// Cell / mark values. 0 = empty, 1 = A (X), 2 = B (O). Kept local (and the
// `Winner` type reused from ./ticTacToe) to avoid duplicate barrel exports.
const EMPTY = 0;
const MARK_A = 1;
const MARK_B = 2;

export interface MultiGameTicTacToeState {
  /** Tunnel object id (0x-hex); bound into the state hash. */
  tunnelId: string;
  /** Current game's 9-cell board, row-major: 0 empty, 1 = A/X, 2 = B/O. */
  board: number[];
  /** Whose turn it is in the current game. A always starts each game. */
  turn: Party;
  /** Marks placed in the CURRENT game (0..9; resets to 0 after each game). */
  movesCount: number;
  /** Cumulative games completed (decisive or drawn). */
  gamesPlayed: number;
  winsA: number;
  winsB: number;
  draws: number;
  /** Running balances (net of every completed game). Always sum to `total`. */
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
  /** Amount shifted from loser to winner on each decisive game. */
  wager: bigint;
  /** Session cap; 0 = open-ended (settle whenever both agree). */
  targetGames: number;
  /** Winner of the most recently completed game (informational, NOT hashed). */
  lastWinner: Winner;
}

/** Domain tag — MUST equal the Move side's `b"multi_tic_tac_toe::session"`. */
const DOMAIN = new TextEncoder().encode("multi_tic_tac_toe::session");

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

/** Detect a winner: 0 none, 1 A, 2 B, 3 draw. Mirrors the Move `check_winner`. */
export function checkWinner(board: number[], movesCount: number): Winner {
  for (const [x, y, z] of LINES) {
    const v = board[x];
    if (v !== EMPTY && v === board[y] && v === board[z]) return v as Winner;
  }
  if (movesCount === 9) return 3;
  return 0;
}

const bmin = (x: bigint, y: bigint): bigint => (x < y ? x : y);

const EMPTY_BOARD = (): number[] => [0, 0, 0, 0, 0, 0, 0, 0, 0];

export class MultiGameTicTacToeProtocol implements Protocol<
  MultiGameTicTacToeState,
  TicTacToeMove
> {
  readonly name = "multi_game_tic_tac_toe.v1";

  private readonly defaultWager: bigint;
  private readonly targetGames: number;

  /**
   * @param targetGames session cap (0 = open-ended; settle by mutual agreement).
   * @param wager amount shifted on each decisive game (clamped to a stake on open).
   */
  constructor(targetGames = 0, wager = 10n) {
    if (targetGames < 0) throw new Error("targetGames must be >= 0");
    if (wager < 0n) throw new Error("wager must be non-negative");
    this.targetGames = targetGames;
    this.defaultWager = wager;
  }

  initialState(ctx: ProtocolContext): MultiGameTicTacToeState {
    const total = ctx.initialBalances.a + ctx.initialBalances.b;
    // Wager cannot exceed what either side can lose on a single game.
    const cap = bmin(ctx.initialBalances.a, ctx.initialBalances.b);
    const wager = bmin(this.defaultWager, cap);
    return {
      tunnelId: ctx.tunnelId,
      board: EMPTY_BOARD(),
      turn: "A",
      movesCount: 0,
      gamesPlayed: 0,
      winsA: 0,
      winsB: 0,
      draws: 0,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total,
      wager,
      targetGames: this.targetGames,
      lastWinner: 0,
    };
  }

  applyMove(
    state: MultiGameTicTacToeState,
    move: TicTacToeMove,
    by: Party,
  ): MultiGameTicTacToeState {
    if (state.targetGames > 0 && state.gamesPlayed >= state.targetGames) {
      throw new Error("session complete: target games reached");
    }
    if (by !== state.turn) throw new Error(`not ${by}'s turn`);
    const { cell } = move;
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) {
      throw new Error(`cell out of range: ${cell}`);
    }
    if (state.board[cell] !== EMPTY) throw new Error(`cell ${cell} occupied`);

    const board = state.board.slice();
    board[cell] = by === "A" ? MARK_A : MARK_B;
    const movesCount = state.movesCount + 1;
    const winner = checkWinner(board, movesCount);

    if (winner === 0) {
      // Game continues; only the board advances, no money moves.
      return {
        ...state,
        board,
        movesCount,
        turn: by === "A" ? "B" : "A",
      };
    }

    // Game finished: fold the result and reset for the next game.
    let { balanceA, balanceB } = state;
    let { winsA, winsB, draws } = state;
    if (winner === 1) {
      const shift = bmin(state.wager, balanceB);
      balanceA += shift;
      balanceB -= shift;
      winsA += 1;
    } else if (winner === 2) {
      const shift = bmin(state.wager, balanceA);
      balanceB += shift;
      balanceA -= shift;
      winsB += 1;
    } else {
      draws += 1;
    }

    return {
      ...state,
      board: EMPTY_BOARD(),
      turn: "A",
      movesCount: 0,
      gamesPlayed: state.gamesPlayed + 1,
      winsA,
      winsB,
      draws,
      balanceA,
      balanceB,
      lastWinner: winner,
    };
  }

  /**
   * Byte-identical to the Move `compute_session_hash_with_id` PRE-IMAGE; the engine
   * blake2b256-hashes this into the tunnel `state_hash`. Do not reorder/extend
   * fields without updating the Move side in lockstep.
   */
  encodeState(state: MultiGameTicTacToeState): Uint8Array {
    return concatBytes([
      DOMAIN,
      addressToBytes32(state.tunnelId),
      Uint8Array.from(state.board),
      Uint8Array.of(state.movesCount),
      u64ToBeBytes(state.gamesPlayed),
      u64ToBeBytes(state.winsA),
      u64ToBeBytes(state.winsB),
      u64ToBeBytes(state.draws),
      u64ToBeBytes(state.balanceA),
      u64ToBeBytes(state.balanceB),
    ]);
  }

  balances(state: MultiGameTicTacToeState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  /** Terminal only at the session cap; open-ended sessions settle by agreement. */
  isTerminal(state: MultiGameTicTacToeState): boolean {
    return state.targetGames > 0 && state.gamesPlayed >= state.targetGames;
  }

  randomMove(
    state: MultiGameTicTacToeState,
    by: Party,
    rng: () => number,
  ): TicTacToeMove | null {
    if (this.isTerminal(state) || by !== state.turn) return null;
    const empties: number[] = [];
    for (let i = 0; i < 9; i++) if (state.board[i] === EMPTY) empties.push(i);
    if (empties.length === 0) return null;
    const idx = Math.floor(rng() * empties.length);
    const cell = empties[idx < empties.length ? idx : empties.length - 1];
    return { cell };
  }
}
