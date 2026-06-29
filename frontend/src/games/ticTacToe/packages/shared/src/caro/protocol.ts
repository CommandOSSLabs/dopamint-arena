/**
 * Caro (five-in-a-row) protocols, game-side (NOT in the SDK). `CaroProtocol` is one game;
 * `MultiGameCaroProtocol` (Task 3) plays N of them in one tunnel. Both implement the SDK's
 * `Protocol` interface so they drop straight into `OffchainTunnel.selfPlay`.
 *
 * When `stake > 0`, a decisive win shifts `min(stake, loserBalance)` from the loser to the
 * winner; a draw leaves balances unchanged. Balances always sum to the locked `total`.
 * encodeState uses a distinct `caro.v2` domain and bakes in the board size, so a caro hash
 * can never collide with a TicTacToe hash or with a caro game of a different size.
 *
 * v2 adds a 32-byte `moveAccumulator` to the co-signed state. Each move folds a
 * salted commitment (`computeCommitment(mover||moveIndex||cell, salt)`) into the
 * accumulator so the full move history is unforgeable without replaying every move.
 */

import { core, protocols, bytesToHex, hexToBytes } from "sui-tunnel-ts";
import type { MoveCodec } from "sui-tunnel-ts/core/distributedFrame";
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
  /** Sum of both balances — invariant across the game (balanceA + balanceB === total). */
  total: bigint;
  /** Amount shifted from loser to winner on a decisive result (0n = money-neutral). */
  stake: bigint;
  /**
   * 32-byte running commitment accumulator. Initialized from the v2 protocol domain;
   * each move folds in `computeCommitment(mover||moveIndex||cell, salt)` so the full
   * move history is unforgeable and auditable without re-replaying every move.
   */
  moveAccumulator: Uint8Array;
}

export type CaroMove = { cell: number; salt: Uint8Array };

/**
 * Codec for `CaroMove`. Encodes the `salt` `Uint8Array` as a hex string so the
 * distributed-tunnel JSON frame preserves the type across the peer transport.
 */
export const caroMoveCodec: MoveCodec<CaroMove> = {
  encode: (m) => ({ cell: m.cell, salt: bytesToHex(m.salt) }),
  decode: (j) => {
    const o = j as { cell: number; salt: string };
    return { cell: o.cell, salt: hexToBytes(o.salt) };
  },
};

const DOMAIN = protocols.protocolDomain("caro.v2");
const MIN_SALT_LEN = 16;

/** `lp(x) = u64be(len(x)) || x` — length-prefixed chunk for the accumulator hash. */
function lp(x: Uint8Array): Uint8Array[] {
  return [core.u64ToBeBytes(x.length), x];
}

/** Initial accumulator value seeded from the v2 protocol domain. */
function initialAccumulator(): Uint8Array {
  return core.blake2b256(
    core.concatBytes([core.DOMAIN_COMMIT_REVEAL, ...lp(DOMAIN)]),
  );
}

/** Fold one commitment into the running accumulator. */
function advanceAccumulator(
  prevAcc: Uint8Array,
  commitment: Uint8Array,
): Uint8Array {
  return core.blake2b256(
    core.concatBytes([
      core.DOMAIN_COMMIT_REVEAL,
      ...lp(prevAcc),
      ...lp(commitment),
    ]),
  );
}

export class CaroProtocol implements Protocol<CaroState, CaroMove> {
  readonly name = "caro.v2";
  private readonly size: number;
  /** Default stake used when the caller does not configure one. */
  private readonly defaultStake: bigint;

  /**
   * @param boardSize edge length of the square board (the client clamps to 9–29; the
   *   protocol allows >= 3 so a 3×3 — which can never make five — is a valid draw fixture).
   * @param stake amount shifted loser→winner on a decisive win (0n = money-neutral).
   */
  constructor(boardSize: number = 19, stake: bigint = 0n) {
    if (!Number.isInteger(boardSize) || boardSize < 3) {
      throw new Error("caro board size must be an integer >= 3");
    }
    if (stake < 0n) throw new Error("stake must be non-negative");
    this.size = boardSize;
    this.defaultStake = stake;
  }

  initialState(ctx: ProtocolContext): CaroState {
    const total = ctx.initialBalances.a + ctx.initialBalances.b;
    // Stake cannot exceed what either party can actually lose.
    const cap =
      ctx.initialBalances.a < ctx.initialBalances.b
        ? ctx.initialBalances.a
        : ctx.initialBalances.b;
    const stake = this.defaultStake < cap ? this.defaultStake : cap;
    return {
      board: new Array(this.size * this.size).fill(0),
      size: this.size,
      turn: "A",
      winner: 0,
      lastMove: -1,
      movesCount: 0,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total,
      stake,
      moveAccumulator: initialAccumulator(),
    };
  }

  applyMove(state: CaroState, move: CaroMove, by: Party): CaroState {
    if (state.winner !== 0) throw new Error("caro: game already over");
    if (by !== state.turn) throw new Error("caro: not this party's turn");
    const { cell, salt } = move;
    if (
      !Number.isInteger(cell) ||
      cell < 0 ||
      cell >= state.size * state.size
    ) {
      throw new Error("caro: cell out of range");
    }
    if (state.board[cell] !== 0) throw new Error("caro: cell occupied");
    if (!salt || salt.length < MIN_SALT_LEN) {
      throw new Error(`caro: salt must be >= ${MIN_SALT_LEN} bytes`);
    }

    const mark = by === "A" ? 1 : 2;
    const board = applyMark(state.board, cell, mark);
    const movesCount = state.movesCount + 1;
    let winner = winnerAround(board, state.size, cell);
    if (winner === 0 && movesCount === state.size * state.size) winner = 3; // draw

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
    // cell is u64be to accommodate large boards (up to 25×25=625 > u8).
    const moverByte = by === "A" ? 1 : 2;
    const value = core.concatBytes([
      Uint8Array.of(moverByte),
      core.u64ToBeBytes(movesCount),
      core.u64ToBeBytes(cell),
    ]);
    const commitment = core.computeCommitment(value, salt);
    const moveAccumulator = advanceAccumulator(
      state.moveAccumulator,
      commitment,
    );

    return {
      ...state,
      board,
      movesCount,
      winner,
      lastMove: cell,
      turn: by === "A" ? "B" : "A",
      balanceA,
      balanceB,
      total: state.total,
      stake: state.stake,
      moveAccumulator,
    };
  }

  encodeState(state: CaroState): Uint8Array {
    // movesCount is intentionally NOT encoded: it is derivable from the board (count of
    // non-empty cells), so two states with the same board are already canonically distinct.
    // The 32-byte moveAccumulator is appended last so v1 and v2 are distinguishable by
    // domain and by length.
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
      state.moveAccumulator,
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

const MULTI_DOMAIN = protocols.protocolDomain("caro.series.v2");

/** Plays `maxGames` Caro games over one tunnel, composing `CaroProtocol`. */
export class MultiGameCaroProtocol implements Protocol<
  MultiGameCaroState,
  MultiGameCaroMove
> {
  readonly name = "caro.series.v2";
  private readonly inner: CaroProtocol;
  private readonly maxGames: number;

  /**
   * @param maxGames  games to play in one tunnel (>= 1)
   * @param boardSize edge length passed to the inner CaroProtocol
   * @param stake     per-game stake passed to the inner CaroProtocol (0n = money-neutral)
   */
  constructor(maxGames: number, boardSize: number = 19, stake: bigint = 0n) {
    if (!Number.isInteger(maxGames) || maxGames < 1) {
      throw new Error("maxGames must be a positive integer");
    }
    this.maxGames = maxGames;
    this.inner = new CaroProtocol(boardSize, stake);
  }

  initialState(ctx: ProtocolContext): MultiGameCaroState {
    return {
      inner: this.inner.initialState(ctx),
      gamesPlayed: 0,
      maxGames: this.maxGames,
    };
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
    // Reset to a fresh board carrying balances forward; the per-game stake shift
    // already happened inside applyMove on the deciding move.
    const carried = this.inner.initialState({
      tunnelId: "",
      initialBalances: { a: state.inner.balanceA, b: state.inner.balanceB },
    });
    return {
      inner: carried,
      gamesPlayed: state.gamesPlayed + 1,
      maxGames: state.maxGames,
    };
  }

  /** Whether both sides hold enough to fund the next staked game. Stake 0 ⇒ always true. */
  canFundNextGame(state: MultiGameCaroState): boolean {
    const stake = state.inner.stake;
    if (stake === 0n) return true;
    return state.inner.balanceA >= stake && state.inner.balanceB >= stake;
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
    // Terminal when the max games count is reached OR neither side can fund the next stake.
    return (
      state.gamesPlayed + 1 >= state.maxGames || !this.canFundNextGame(state)
    );
  }

  randomMove(
    state: MultiGameCaroState,
    by: Party,
    rng: () => number,
  ): MultiGameCaroMove | null {
    if (this.isTerminal(state)) return null;
    // Derive a 16-byte deterministic salt from the rng.
    const saltBytes = new Uint8Array(16);
    const saltView = new DataView(saltBytes.buffer);
    saltView.setFloat64(0, rng(), false);
    saltView.setFloat64(8, rng(), false);
    const salt = saltBytes;
    // Between games only A drives the advance (mirrors TTT); mid-game the hook supplies moves.
    if (this.inner.isTerminal(state.inner))
      return by === "A" ? { cell: 0, salt } : null;
    // Mid-game fallback: first empty cell (the real bot uses caro/bot.ts instead).
    const i = state.inner.board.findIndex((c) => c === 0);
    return i >= 0 ? { cell: i, salt } : null;
  }
}
