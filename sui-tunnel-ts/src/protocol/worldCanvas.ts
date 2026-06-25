/**
 * World Canvas protocol: an APPEND-ONLY paint stream over an infinite, chunked
 * pixel wall ("The World is Your Canvas"), driven across a two-party tunnel.
 *
 * This is the showcase for ENDLESS / GROWING state handled in O(1): the signed
 * state never carries the painted canvas. Each paint is folded into a fixed
 * 32-byte rolling digest
 *
 *   rollingDigest_0 = 32 zero bytes
 *   rollingDigest_n = blake2b256(rollingDigest_{n-1} || encodeMove(move, painter))
 *
 * so `encodeState()` is fixed-size and per-paint work is constant no matter how
 * many millions of cells get painted. Because every paint mutates the digest
 * (the painter byte and a strictly-fresh coordinate are always folded in), the
 * co-signed tunnel state hash STRICTLY CHANGES on every paint — there is no
 * no-op — which is exactly what turns one paint into one co-signed off-chain
 * move (one on-chain function-call-equivalent → 1 TPS).
 *
 * There are no turns and no winner: either party may paint any cell at any time
 * (like the chat transcript), and the canvas is collaborative, not a duel. This
 * is FREE / draw mode — balances are locked at open and never shift, so every
 * close is a draw with zero dispute surface. The session is terminal only at a
 * very large placement `cap`, so for any realistic run it is effectively
 * continuous (paint forever).
 *
 * Coordinates are a (chunk, in-chunk) pair: `cx`/`cy` are signed 64-bit chunk
 * indices (the canvas is infinite in every direction) and `x`/`y` are the cell
 * within a `chunkSize`×`chunkSize` chunk. `color` is a palette index in
 * `[0, numColors)`.
 */

import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
  rollingDigest,
} from "./Protocol";
import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";
import { blake2b256 } from "../core/crypto";

/** Cells per chunk edge. A chunk is `chunkSize`×`chunkSize` cells. */
export const DEFAULT_CHUNK_SIZE = 256;
/** Number of paintable palette colors; a paint's `color` is in `[0, numColors)`. */
export const DEFAULT_NUM_COLORS = 16;
/**
 * Placements after which the session is terminal. Set astronomically high so the
 * wall is effectively continuous — terminality exists only to honor the Protocol
 * contract (the tunnel can always reach a settleable, draw state).
 */
export const DEFAULT_CAP = 1_000_000_000_000n;

/** Bound for a signed 64-bit chunk index, so zigzag stays within u64. */
const COORD_MIN = -(1n << 63n);
const COORD_MAX = (1n << 63n) - 1n;

export interface WorldCanvasConfig {
  /** Cells per chunk edge (default 256). Bounds `x`/`y` to `[0, chunkSize)`. */
  chunkSize?: number;
  /** Palette size (default 16). Bounds `color` to `[0, numColors)`. */
  numColors?: number;
  /** Placements after which the session is terminal (default ~1e12 → continuous). */
  cap?: bigint;
}

export interface WorldCanvasState {
  /** 32-byte fold of the whole paint stream (NOT the canvas itself). */
  rollingDigest: Uint8Array;
  /** Total paints folded into the digest; the single terminal trigger at `cap`. */
  count: bigint;
  /** Painter of the most recent paint, or null before any paint. */
  lastPainter: Party | null;
  /** Locked at open; never shifts (collaborative free mode = forced draw). */
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
}

export interface WorldCanvasMove {
  /** Signed 64-bit chunk index (infinite canvas), x axis. */
  cx: bigint;
  /** Signed 64-bit chunk index (infinite canvas), y axis. */
  cy: bigint;
  /** Cell column within the chunk, `[0, chunkSize)`. */
  x: number;
  /** Cell row within the chunk, `[0, chunkSize)`. */
  y: number;
  /** Palette index, `[0, numColors)`. */
  color: number;
}

const ZERO32 = new Uint8Array(32);

/** Stable per-party byte mixed into each paint delta (digest is painter-sensitive). */
function painterByte(p: Party): number {
  return p === "A" ? 0x01 : 0x02;
}

/**
 * Map a signed 64-bit chunk index to an unsigned u64 so it can be byte-encoded
 * (standard zigzag: 0,-1,1,-2,2 → 0,1,2,3,4). Keeps negative coordinates
 * (the canvas extends in every direction) in the canonical fold.
 */
function zigzag64(n: bigint): bigint {
  return (n << 1n) ^ (n >> 63n);
}

/**
 * Canonical bytes for one paint, folded into the rolling digest. Includes the
 * painter byte so identical coordinates by different parties diverge the digest.
 */
export function encodeWorldCanvasMove(
  move: WorldCanvasMove,
  by: Party,
): Uint8Array {
  return concatBytes([
    Uint8Array.of(painterByte(by)),
    u64ToBeBytes(zigzag64(move.cx)),
    u64ToBeBytes(zigzag64(move.cy)),
    u64ToBeBytes(move.x),
    u64ToBeBytes(move.y),
    Uint8Array.of(move.color),
  ]);
}

export class WorldCanvasProtocol
  implements Protocol<WorldCanvasState, WorldCanvasMove>
{
  readonly name = "world_canvas.v1";

  private readonly domain: Uint8Array;
  private readonly chunkSize: number;
  private readonly numColors: number;
  private readonly cap: bigint;

  constructor(cfg: WorldCanvasConfig = {}) {
    this.domain = protocolDomain(this.name);
    this.chunkSize = cfg.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.numColors = cfg.numColors ?? DEFAULT_NUM_COLORS;
    this.cap = cfg.cap ?? DEFAULT_CAP;
    if (!Number.isInteger(this.chunkSize) || this.chunkSize <= 0) {
      throw new Error("chunkSize must be a positive integer");
    }
    if (!Number.isInteger(this.numColors) || this.numColors <= 0) {
      throw new Error("numColors must be a positive integer");
    }
    if (this.cap <= 0n) throw new Error("cap must be positive");
  }

  initialState(ctx: ProtocolContext): WorldCanvasState {
    return {
      rollingDigest: ZERO32,
      count: 0n,
      lastPainter: null,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
    };
  }

  applyMove(
    state: WorldCanvasState,
    move: WorldCanvasMove,
    by: Party,
  ): WorldCanvasState {
    if (state.count >= this.cap) throw new Error("canvas paint cap reached");

    const { cx, cy, x, y, color } = move;
    if (typeof cx !== "bigint" || cx < COORD_MIN || cx > COORD_MAX) {
      throw new Error(`chunk cx out of signed-64 range: ${cx}`);
    }
    if (typeof cy !== "bigint" || cy < COORD_MIN || cy > COORD_MAX) {
      throw new Error(`chunk cy out of signed-64 range: ${cy}`);
    }
    if (!Number.isInteger(x) || x < 0 || x >= this.chunkSize) {
      throw new Error(`x out of range: ${x}`);
    }
    if (!Number.isInteger(y) || y < 0 || y >= this.chunkSize) {
      throw new Error(`y out of range: ${y}`);
    }
    if (!Number.isInteger(color) || color < 0 || color >= this.numColors) {
      throw new Error(`color out of range: ${color}`);
    }

    // Fold this paint into the rolling digest (O(1)); the painter byte and the
    // coordinate guarantee the digest strictly changes on every paint.
    const nextDigest = rollingDigest(
      blake2b256,
      state.rollingDigest,
      encodeWorldCanvasMove(move, by),
    );

    // Free/draw mode: balances are locked for the session's life.
    return {
      rollingDigest: nextDigest,
      count: state.count + 1n,
      lastPainter: by,
      balanceA: state.balanceA,
      balanceB: state.balanceB,
      total: state.total,
    };
  }

  encodeState(state: WorldCanvasState): Uint8Array {
    // Fixed-size canonical encoding: domain || digest(32) || count || balances.
    // Independent of how many cells have been painted (O(1) per update).
    return concatBytes([
      this.domain,
      state.rollingDigest,
      u64ToBeBytes(state.count),
      u64ToBeBytes(state.balanceA),
      u64ToBeBytes(state.balanceB),
    ]);
  }

  balances(state: WorldCanvasState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(state: WorldCanvasState): boolean {
    // Effectively continuous: terminal only at the (astronomical) placement cap.
    return state.count >= this.cap;
  }

  /**
   * A random paint for autonomous agents — random chunk within `spread` of the
   * origin (so bots cluster into a visible region), random cell and color.
   */
  randomMove(
    state: WorldCanvasState,
    _by: Party,
    rng: () => number,
    spread = 8,
  ): WorldCanvasMove | null {
    if (state.count >= this.cap) return null;
    const pick = (n: number) => Math.min(n - 1, Math.floor(rng() * n));
    return {
      cx: BigInt(pick(2 * spread + 1) - spread),
      cy: BigInt(pick(2 * spread + 1) - spread),
      x: pick(this.chunkSize),
      y: pick(this.chunkSize),
      color: pick(this.numColors),
    };
  }
}
