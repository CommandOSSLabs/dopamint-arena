/**
 * The 2-party PvP protocol for "The World is Your Canvas" — used ONLY by online PvP
 * (two real humans co-signing ONE shared tunnel), separate from the solo wall.
 *
 * Co-sign parity (the hard constraint): both clients must compute the SAME state hash
 * from the SAME ordered moves. We use a fixed-size ROLLING DIGEST for {@link encodeState}
 * (O(1) per paint, identical on both sides), exactly like the solo protocol — the digest
 * is the co-signed truth. A `cells` array rides along in state PURELY for rendering
 * ({@link deriveView}); it is NOT encoded, so capping it for memory can never desync the
 * two parties' state hashes. Free/draw: balances never move, there is never a winner.
 */
import { blake2b256 } from "sui-tunnel-ts";
import {
  rollingDigest,
  protocolDomain,
  type Protocol,
  type Party,
  type Balances,
  type ProtocolContext,
} from "sui-tunnel-ts/protocol/Protocol";
import type { MoveCodec } from "sui-tunnel-ts/core/distributedFrame";
import type { WorldCanvasMove } from "sui-tunnel-ts/protocol/worldCanvas";

const NAME = "world-canvas-pvp";
const NUM_COLORS = 16;
/** Cells per chunk edge — matches the canonical protocol + the solo wall (single grid). */
export const CHUNK_SIZE = 256;
/** Render-only cap; eviction is deterministic (drop oldest) so both sides stay identical. */
const MAX_RENDER_CELLS = 8000;

/**
 * A single co-signed paint. Coordinates are (chunk, in-chunk): `cx`/`cy` are signed
 * 64-bit chunk indices (the canvas is infinite in every direction) and `x`/`y` are the
 * cell within a `CHUNK_SIZE`×`CHUNK_SIZE` chunk; `color` is a palette index. This is the
 * canonical {@link WorldCanvasMove}, so `cx`/`cy` are BIGINT — the relay envelope is JSON
 * (which can't carry bigint), so the tunnel MUST be built with {@link worldCanvasMoveCodec}
 * (decimal-string chunk coords). Without it, `JSON.stringify` drops the coords and the
 * opponent decodes an undefined paint → nothing renders on the far side.
 */
export type PvpPaintMove = WorldCanvasMove;

/** A painted cell flattened for rendering (global-pixel coords + palette index + painter seat). */
export interface PvpCell {
  gx: number;
  gy: number;
  color: number;
  by: Party;
  /** Monotonic paint order (both parties assign identically) — lets the renderer fold
   *  the cell stream incrementally. Render-only; not part of `encodeState`. */
  seq: number;
}

export interface PvpCanvasState {
  /** Rolling 32-byte digest of every co-signed paint — the canonical state hash. */
  digest: Uint8Array;
  /** Render-only painted cells (capped); never part of `encodeState`. */
  cells: PvpCell[];
  /** Monotonic count of paints applied (drives `PvpCell.seq`). Render-only. */
  paintCount: number;
  /** Free/draw: there is never a winner. Present so the PvP engine can read it. */
  winner: null;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
}

const enc = new TextEncoder();
/** Deterministic per-paint delta folded into the digest (same on both parties). */
function moveDelta(mv: PvpPaintMove, by: Party): Uint8Array {
  return enc.encode(`${by}|${mv.cx},${mv.cy}|${mv.x},${mv.y}|${mv.color}`);
}

export class WorldCanvasPvpProtocol
  implements Protocol<PvpCanvasState, PvpPaintMove>
{
  readonly name = NAME;

  initialState(ctx: ProtocolContext): PvpCanvasState {
    return {
      digest: blake2b256(protocolDomain(NAME)),
      cells: [],
      paintCount: 0,
      winner: null,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
    };
  }

  applyMove(
    state: PvpCanvasState,
    move: PvpPaintMove,
    by: Party,
  ): PvpCanvasState {
    if (
      typeof move.cx !== "bigint" ||
      typeof move.cy !== "bigint" ||
      !Number.isInteger(move.x) ||
      move.x < 0 ||
      move.x >= CHUNK_SIZE ||
      !Number.isInteger(move.y) ||
      move.y < 0 ||
      move.y >= CHUNK_SIZE ||
      !Number.isInteger(move.color) ||
      move.color < 0 ||
      move.color >= NUM_COLORS
    ) {
      throw new Error("world-canvas-pvp: illegal paint");
    }
    const digest = rollingDigest(blake2b256, state.digest, moveDelta(move, by));
    const seq = state.paintCount + 1;
    // Flatten (chunk, in-chunk) back to the global-pixel grid the renderer draws on.
    const cell: PvpCell = {
      gx: Number(move.cx) * CHUNK_SIZE + move.x,
      gy: Number(move.cy) * CHUNK_SIZE + move.y,
      color: move.color,
      by,
      seq,
    };
    const cells =
      state.cells.length >= MAX_RENDER_CELLS
        ? [...state.cells.slice(state.cells.length - MAX_RENDER_CELLS + 1), cell]
        : [...state.cells, cell];
    return { ...state, digest, cells, paintCount: seq };
  }

  encodeState(state: PvpCanvasState): Uint8Array {
    return state.digest;
  }

  balances(state: PvpCanvasState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  /** Endless co-draw — never terminal (no winner, no auto-settle; closing tears down). */
  isTerminal(): boolean {
    return false;
  }

  /** Bot autopilot: paint a random cell in this seat's own band so the two bots' art
   *  stays visually distinct (seat A left, seat B right), both within the origin chunk. */
  randomMove(
    _state: PvpCanvasState,
    by: Party,
    rng: () => number,
  ): PvpPaintMove {
    const band = by === "A" ? 0 : 70;
    return {
      cx: 0n,
      cy: 0n,
      x: band + Math.floor(rng() * 60),
      y: Math.floor(rng() * 90),
      color: by === "A" ? 13 : 15, // Sui blue vs light purple, like the solo seats
    };
  }
}

/**
 * Move (de)serializer for the PvP relay. The frame envelope is JSON, which can't carry
 * the move's bigint chunk indices (`cx`/`cy`) — those are encoded as decimal strings here
 * and restored with `BigInt(...)` on the far side. Pass as the tunnel's `moveCodec` so the
 * opponent receives intact coordinates (and the same paint renders on both walls).
 */
export const worldCanvasMoveCodec: MoveCodec<WorldCanvasMove> = {
  encode(m) {
    return {
      cx: m.cx.toString(),
      cy: m.cy.toString(),
      x: m.x,
      y: m.y,
      color: m.color,
    };
  },
  decode(j) {
    const o = j as {
      cx?: string;
      cy?: string;
      x?: number;
      y?: number;
      color?: number;
    };
    return {
      cx: BigInt(o.cx ?? "0"),
      cy: BigInt(o.cy ?? "0"),
      x: o.x ?? 0,
      y: o.y ?? 0,
      color: o.color ?? 0,
    };
  },
};
