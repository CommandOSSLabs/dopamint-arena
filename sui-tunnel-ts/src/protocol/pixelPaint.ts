/**
 * Pixel Paint protocol: a two-painter pixel-canvas tunnel with three modes.
 *
 * One canvas, two painters, no turns (either party may paint any cell at any
 * time, like the chat protocol). Every accepted move increments both `placed`
 * and one `paints[idx]`, so the co-signed state hash strictly changes on every
 * move (no no-op is possible) and the finite paint pool guarantees the session
 * always reaches terminal. The `mode` selects what the painters are fighting
 * (or cooperating) over:
 *
 *  - WAR (default) — territory war. Painting a cell sets its OWNER to the
 *    painter; whoever OWNS more cells at terminal wins and takes a `stake` from
 *    the loser (a draw shifts nothing). This mode is the historical behavior and
 *    is preserved byte- and behavior-identical.
 *  - SCENE — both painters race to fill a shared stencil (`target`). Only stencil
 *    cells are paintable, and only with their required color; correctness is
 *    banked by whoever lays the LOCKING paint on a stencil cell. Most correct
 *    cells at terminal wins the stake (tie = draw). Settles when every stencil
 *    cell is locked.
 *  - FREE — cooperative free-paint (war paint rules, no target). Forced draw at
 *    terminal: settleable with NO stake shift. Used to generate co-signed-tx
 *    throughput where the outcome is irrelevant.
 *
 * The shared invariant across modes: each cell tolerates at most `overwriteLimit`
 * paints, then LOCKS forever at its last painter's color/ownership; any further
 * paint there is illegal (rejected for everyone, including the owner). The session
 * is terminal at a placement `cap` OR when the deciding set of cells is locked.
 * Balances always sum to the locked total, so it settles on the tunnel exactly
 * like tic-tac-toe.
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

/** Cell ownership / mark. 0 = empty (no owner), 1 = A, 2 = B (= last painter). */
export const EMPTY = 0;
export const OWNER_A = 1;
export const OWNER_B = 2;
/** Number of paintable palette colors; canvas value 0 is reserved for "empty". */
export const NUM_COLORS = 16;

/** Encoded `mode` byte. WAR is the default and preserves the historical game. */
export const MODE_WAR = 0;
export const MODE_SCENE = 1;
export const MODE_FREE = 2;

export type PixelPaintMode = "war" | "scene" | "free";

/** Winner codes (mirror tic-tac-toe): 0 none, 1 A, 2 B, 3 draw. */
export type Winner = 0 | 1 | 2 | 3;

const MODE_NAME: Record<PixelPaintMode, string> = {
  war: "pixel_paint.war.v1",
  scene: "pixel_paint.scene.v1",
  free: "pixel_paint.free.v1",
};

const MODE_CODE: Record<PixelPaintMode, number> = {
  war: MODE_WAR,
  scene: MODE_SCENE,
  free: MODE_FREE,
};

const ZERO32 = new Uint8Array(32);

export interface PixelPaintConfig {
  width?: number;
  height?: number;
  /** Total placements after which the session is terminal. */
  cap?: number;
  /** Paints a single cell tolerates before it LOCKS (no one may repaint it). */
  overwriteLimit?: number;
  /** Amount shifted loser→winner on a decisive territory/scene result. */
  stake?: bigint;
  /** War (default), Scene (shared stencil race), or Free (cooperative draw). */
  mode?: PixelPaintMode;
  /**
   * SCENE only: the shared stencil, length width*height, row-major. 0 = don't-care
   * (background, never paintable); 1..NUM_COLORS = the color required at that cell.
   */
  target?: Uint8Array;
}

export interface PixelPaintState {
  width: number;
  height: number;
  /** width*height palette indices, row-major. 0 = empty, 1..NUM_COLORS = color. */
  canvas: Uint8Array;
  /** width*height owners, row-major. 0 = empty, 1 = A, 2 = B (last painter). */
  owner: Uint8Array;
  /** width*height paint counts. A cell LOCKS when paints[i] === overwriteLimit. */
  paints: Uint8Array;

  /** Total paints across both painters (one terminal trigger at `cap`). */
  placed: number;
  placedA: number;
  placedB: number;

  /** Cells currently owned by each seat — the territory that decides a WAR win. */
  ownedA: number;
  ownedB: number;
  /** SCENE: stencil cells each seat locked at the required color (decides a SCENE win). */
  correctA: number;
  correctB: number;
  /** SCENE: number of stencil cells (target[i] !== 0); SCENE settles when locked === this. 0 otherwise. */
  targetCellCount: number;
  /** 32-byte commit to the SCENE stencil (ZERO for war/free). Binds the off-chain target to the state hash. */
  targetCommit: Uint8Array;
  /** Locked-cell count; when === width*height the board is fully locked (terminal). */
  locked: number;

  /** Encoded mode: MODE_WAR | MODE_SCENE | MODE_FREE. */
  mode: number;
  cap: number;
  overwriteLimit: number;
  winner: Winner;

  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
  /** Amount shifted loser→winner on a decisive result. */
  stake: bigint;
}

export interface PixelPaintMove {
  x: number;
  y: number;
  /** Palette color, 1..NUM_COLORS. */
  color: number;
}

export class PixelPaintProtocol
  implements Protocol<PixelPaintState, PixelPaintMove>
{
  readonly name: string;

  private readonly mode: PixelPaintMode;
  private readonly modeCode: number;
  private readonly domain: Uint8Array;
  private readonly width: number;
  private readonly height: number;
  private readonly cap: number;
  private readonly overwriteLimit: number;
  private readonly defaultStake: bigint;
  /** SCENE stencil (kept off-state; only its 32-byte commit lives in the state). */
  private readonly target: Uint8Array | null;
  private readonly targetCellCount: number;
  private readonly targetCommit: Uint8Array;

  constructor(cfg: PixelPaintConfig = {}) {
    this.mode = cfg.mode ?? "war";
    this.modeCode = MODE_CODE[this.mode];
    this.name = MODE_NAME[this.mode];
    this.domain = protocolDomain(this.name);

    this.width = cfg.width ?? 64;
    this.height = cfg.height ?? 64;
    this.cap = cfg.cap ?? 1024;
    this.overwriteLimit = cfg.overwriteLimit ?? 3;
    this.defaultStake = cfg.stake ?? 100n;
    if (this.width <= 0 || this.height <= 0) {
      throw new Error("canvas dimensions must be positive");
    }
    if (this.cap <= 0) throw new Error("cap must be positive");
    if (this.overwriteLimit < 1) throw new Error("overwriteLimit must be >= 1");
    if (this.defaultStake < 0n) throw new Error("stake must be non-negative");

    if (this.mode === "scene") {
      const target = cfg.target;
      if (!target || target.length !== this.width * this.height) {
        throw new Error("scene mode requires target of length width*height");
      }
      let count = 0;
      for (let i = 0; i < target.length; i++) {
        if (target[i] > NUM_COLORS) {
          throw new Error(`scene target color out of range at ${i}: ${target[i]}`);
        }
        if (target[i] !== 0) count++;
      }
      if (count < 1) throw new Error("scene target must require at least one cell");
      this.target = target;
      this.targetCellCount = count;
      this.targetCommit = blake2b256(
        concatBytes([
          this.domain,
          u64ToBeBytes(BigInt(this.width)),
          u64ToBeBytes(BigInt(this.height)),
          target,
        ]),
      );
    } else {
      this.target = null;
      this.targetCellCount = 0;
      this.targetCommit = ZERO32;
    }
  }

  initialState(ctx: ProtocolContext): PixelPaintState {
    const size = this.width * this.height;
    const total = ctx.initialBalances.a + ctx.initialBalances.b;
    // Stake cannot exceed what either party can actually lose.
    const clampCap =
      ctx.initialBalances.a < ctx.initialBalances.b
        ? ctx.initialBalances.a
        : ctx.initialBalances.b;
    const stake = this.defaultStake < clampCap ? this.defaultStake : clampCap;
    return {
      width: this.width,
      height: this.height,
      canvas: new Uint8Array(size),
      owner: new Uint8Array(size),
      paints: new Uint8Array(size),
      placed: 0,
      placedA: 0,
      placedB: 0,
      ownedA: 0,
      ownedB: 0,
      correctA: 0,
      correctB: 0,
      targetCellCount: this.targetCellCount,
      targetCommit: this.targetCommit,
      locked: 0,
      mode: this.modeCode,
      cap: this.cap,
      overwriteLimit: this.overwriteLimit,
      winner: 0,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total,
      stake,
    };
  }

  applyMove(
    state: PixelPaintState,
    move: PixelPaintMove,
    by: Party,
  ): PixelPaintState {
    if (state.winner !== 0) throw new Error("game already over");

    const { x, y, color } = move;
    if (!Number.isInteger(x) || x < 0 || x >= state.width) {
      throw new Error(`x out of range: ${x}`);
    }
    if (!Number.isInteger(y) || y < 0 || y >= state.height) {
      throw new Error(`y out of range: ${y}`);
    }
    if (!Number.isInteger(color) || color < 1 || color > NUM_COLORS) {
      throw new Error(`color out of range: ${color}`);
    }

    const idx = y * state.width + x;
    // OVERLAP LIMIT: a locked cell rejects all painters (including its owner).
    if (state.paints[idx] >= state.overwriteLimit) {
      throw new Error(`cell (${x},${y}) is locked at ${state.overwriteLimit} paints`);
    }
    // SCENE gate: only stencil cells, only at their required color.
    if (this.mode === "scene") {
      if (this.target![idx] === 0) {
        throw new Error(`cell (${x},${y}) is off-scene`);
      }
      if (color !== this.target![idx]) {
        throw new Error(`cell (${x},${y}) is not the scene color`);
      }
    }

    const canvas = state.canvas.slice();
    const owner = state.owner.slice();
    const paints = state.paints.slice();

    const prevOwner = owner[idx];
    const mine = by === "A" ? OWNER_A : OWNER_B;

    canvas[idx] = color;
    owner[idx] = mine;
    paints[idx] = state.paints[idx] + 1;

    // O(1) maintained counters.
    let ownedA = state.ownedA;
    let ownedB = state.ownedB;
    let correctA = state.correctA;
    let correctB = state.correctB;
    let locked = state.locked;
    if (prevOwner === OWNER_A) ownedA--;
    else if (prevOwner === OWNER_B) ownedB--;
    if (mine === OWNER_A) ownedA++;
    else ownedB++;
    if (paints[idx] === state.overwriteLimit) {
      locked++;
      // SCENE scoring banks ONLY at the locking paint: the painter who locks a
      // stencil cell at its required color owns that correctness permanently.
      if (
        this.mode === "scene" &&
        canvas[idx] === this.target![idx] &&
        this.target![idx] !== 0
      ) {
        if (mine === OWNER_A) correctA++;
        else correctB++;
      }
    }

    const placed = state.placed + 1;
    const placedA = state.placedA + (by === "A" ? 1 : 0);
    const placedB = state.placedB + (by === "B" ? 1 : 0);

    // Terminal triggers: placement cap, the scene stencil fully locked, or the
    // whole board locked — whichever comes first.
    const sceneSettled =
      this.mode === "scene" && locked === state.targetCellCount;
    const fullyLocked = locked === state.width * state.height;
    let winner: Winner = 0;
    if (placed >= state.cap || sceneSettled || fullyLocked) {
      if (this.mode === "scene") {
        winner = correctA > correctB ? 1 : correctB > correctA ? 2 : 3;
      } else if (this.mode === "free") {
        winner = 3; // cooperative: forced draw, settles with no stake shift
      } else {
        winner = ownedA > ownedB ? 1 : ownedB > ownedA ? 2 : 3;
      }
    }

    // Stake settlement — same shape as tic-tac-toe; balances stay summing to total.
    let balanceA = state.balanceA;
    let balanceB = state.balanceB;
    if (winner === 1 || winner === 2) {
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

    return {
      ...state,
      canvas,
      owner,
      paints,
      placed,
      placedA,
      placedB,
      ownedA,
      ownedB,
      correctA,
      correctB,
      locked,
      winner,
      balanceA,
      balanceB,
    };
  }

  encodeState(state: PixelPaintState): Uint8Array {
    // All three per-cell arrays are fixed-length (width*height); the trailing
    // fixed-width counters keep the whole encoding canonical and collision-free.
    return concatBytes([
      this.domain,
      u64ToBeBytes(BigInt(state.width)),
      u64ToBeBytes(BigInt(state.height)),
      state.canvas,
      state.owner,
      state.paints,
      u64ToBeBytes(BigInt(state.placed)),
      u64ToBeBytes(BigInt(state.placedA)),
      u64ToBeBytes(BigInt(state.placedB)),
      u64ToBeBytes(BigInt(state.ownedA)),
      u64ToBeBytes(BigInt(state.ownedB)),
      u64ToBeBytes(BigInt(state.correctA)),
      u64ToBeBytes(BigInt(state.correctB)),
      u64ToBeBytes(BigInt(state.targetCellCount)),
      state.targetCommit,
      u64ToBeBytes(BigInt(state.locked)),
      u64ToBeBytes(BigInt(state.cap)),
      u64ToBeBytes(BigInt(state.overwriteLimit)),
      Uint8Array.of(state.mode),
      Uint8Array.of(state.winner),
      u64ToBeBytes(state.balanceA),
      u64ToBeBytes(state.balanceB),
      u64ToBeBytes(state.stake),
    ]);
  }

  balances(state: PixelPaintState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(state: PixelPaintState): boolean {
    return state.winner !== 0;
  }

  randomMove(
    state: PixelPaintState,
    _by: Party,
    rng: () => number,
  ): PixelPaintMove | null {
    if (state.winner !== 0) return null;
    // Legal targets: unlocked cells; in SCENE also restricted to stencil cells.
    const free: number[] = [];
    for (let i = 0; i < state.paints.length; i++) {
      if (state.paints[i] >= state.overwriteLimit) continue;
      if (this.mode === "scene" && this.target![i] === 0) continue;
      free.push(i);
    }
    if (free.length === 0) return null; // no legal move == terminal
    const idx = free[Math.min(free.length - 1, Math.floor(rng() * free.length))];
    // SCENE must paint the required color; war/free pick any palette color.
    const color =
      this.mode === "scene"
        ? this.target![idx]
        : 1 + Math.min(NUM_COLORS - 1, Math.floor(rng() * NUM_COLORS));
    return { x: idx % state.width, y: (idx / state.width) | 0, color };
  }
}
