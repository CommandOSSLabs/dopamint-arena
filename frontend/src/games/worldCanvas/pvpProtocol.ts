/**
 * The 2-party PvP protocol for "The World is Your Canvas" — used ONLY by online PvP
 * (two real humans co-signing ONE shared tunnel), separate from the solo wall.
 *
 * Co-sign parity (the hard constraint): both clients must compute the SAME state hash
 * from the SAME ordered cells. Every painted cell folds into a fixed-size ROLLING DIGEST
 * ({@link encodeState}), exactly like the solo protocol — the digest is the co-signed
 * truth. A `cells` array rides along PURELY for rendering ({@link deriveView}); it is NOT
 * encoded, so capping it can never desync the two parties. Free/draw: no winner.
 *
 * BATCHED moves: one co-signed move carries a RUN of cells (a stroke segment), not a
 * single pixel — so a drag crosses the tunnel in ONE co-sign (smooth, and the opponent
 * gets the whole stroke instead of sparse per-turn samples). Cells fold in array order,
 * keeping both parties byte-identical.
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

const NAME = "world-canvas-pvp";
const NUM_COLORS = 16;
/** Cells per chunk edge — matches the canonical protocol + the solo wall (single grid). */
export const CHUNK_SIZE = 256;
/** Render-only cap; eviction is deterministic (drop oldest) so both sides stay identical. */
const MAX_RENDER_CELLS = 8000;
/** Max cells in one co-signed batch — bounds the relay frame size for a stroke segment. */
export const MAX_BATCH_CELLS = 128;
/** Cells the bot lays down per co-sign — a short flowing run, not a single dot. */
const BOT_RUN = 8;

/**
 * One painted cell, in (chunk, in-chunk) coords: `cx`/`cy` are signed chunk indices (the canvas
 * is infinite) and `x`/`y` the cell within a `CHUNK_SIZE`×`CHUNK_SIZE` chunk; `color` is a palette
 * index. The move is JSON-NATIVE — `cx`/`cy` are JS safe ints (a ~9-quadrillion-pixel canvas fits
 * in a `Number`), so the relay carries it with no codec, exactly like chicken-cross's `{dirA}`.
 *
 * `seq` is a PER-SEAT monotonic stamp assigned by whoever paints the seat (you, or your bot).
 * It is the IDEMPOTENCY KEY that makes the at-least-once batch buffer safe: {@link
 * WorldCanvasPvpProtocol.applyMove} folds a cell only when its `seq` exceeds the seat's
 * last-applied seq, so a RE-SENT run (the buffer re-proposing cells already on-chain) is a
 * deterministic no-op on BOTH parties instead of a double-fold that would diverge the digest.
 * It is NOT folded into the digest — purely the fold/skip gate.
 */
export interface PvpCellMove {
  /** Signed chunk index (JS safe int); the canvas is infinite in every direction. */
  cx: number;
  cy: number;
  /** Cell within the chunk: `0 ≤ x,y < CHUNK_SIZE`. */
  x: number;
  y: number;
  /** Palette index. */
  color: number;
  /** Per-seat monotonic sequence; a cell folds iff `seq` exceeds the seat's last-applied seq. */
  seq: number;
}

/** The co-signed tunnel move: a RUN of cells (a stroke segment) committed in one co-sign. */
export interface PvpPaintMove {
  cells: PvpCellMove[];
}

/** A painted cell flattened for rendering (global-pixel coords + palette index + painter seat). */
export interface PvpCell {
  gx: number;
  gy: number;
  color: number;
  by: Party;
  /** Monotonic GLOBAL paint order (both parties assign identically) — lets the renderer fold
   *  the cell stream incrementally. Render-only; not part of `encodeState`. */
  seq: number;
  /** Per-seat seq of the source move — lets the hook seed its own seq counter cap-safely
   *  (it survives the render cap, which only drops the oldest cells). Render-only. */
  pseq: number;
}

export interface PvpCanvasState {
  /** Rolling 32-byte digest of every co-signed cell — the canonical state hash. */
  digest: Uint8Array;
  /** Render-only painted cells (capped); never part of `encodeState`. */
  cells: PvpCell[];
  /** Monotonic count of cells folded (drives the GLOBAL `PvpCell.seq`). Render-only. */
  paintCount: number;
  /** Highest per-seat seq folded for each seat — the idempotency cursor. Parity-critical:
   *  both parties advance it identically, so the seq gate decides fold/skip the SAME way on
   *  both sides. Reconstructed only from the applied move stream (not from the digest), so it
   *  is NOT in `encodeState` but MUST be persisted for resume. */
  appliedSeqA: number;
  appliedSeqB: number;
  /** Free/draw: there is never a winner. Present so the PvP engine can read it. */
  winner: null;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
}

const enc = new TextEncoder();
/** Deterministic per-cell delta folded into the digest (same on both parties). */
function cellDelta(c: PvpCellMove, by: Party): Uint8Array {
  return enc.encode(`${by}|${c.cx},${c.cy}|${c.x},${c.y}|${c.color}`);
}

function isLegalCell(c: PvpCellMove): boolean {
  return (
    Number.isInteger(c.cx) &&
    Number.isInteger(c.cy) &&
    Number.isInteger(c.x) &&
    c.x >= 0 &&
    c.x < CHUNK_SIZE &&
    Number.isInteger(c.y) &&
    c.y >= 0 &&
    c.y < CHUNK_SIZE &&
    Number.isInteger(c.color) &&
    c.color >= 0 &&
    c.color < NUM_COLORS &&
    Number.isInteger(c.seq) &&
    c.seq >= 0
  );
}

/** Up to the last two cells THIS seat painted, most-recent first — its pen + heading.
 *  Lets the bot CONTINUE its own stroke (a flowing line) instead of teleporting. The
 *  last seat-A cell tracks YOUR paints too, so re-enabling Auto resumes where you left off. */
function recentCellsBy(cells: PvpCell[], by: Party): PvpCell[] {
  const out: PvpCell[] = [];
  for (let i = cells.length - 1; i >= 0 && out.length < 2; i--) {
    if (cells[i].by === by) out.push(cells[i]);
  }
  return out;
}

/** Clamp a per-tick step so the walk stays a tight, legible line (no big jumps). */
function clampStep(d: number): number {
  return Math.max(-2, Math.min(2, d));
}

/** Flatten a global-pixel cell to a (chunk, in-chunk) move with its per-seat `seq`; floorDiv
 *  keeps x/y in-range for negative globals (the canvas extends in every direction). */
function toCellMove(
  gx: number,
  gy: number,
  color: number,
  seq: number,
): PvpCellMove {
  const cx = Math.floor(gx / CHUNK_SIZE);
  const cy = Math.floor(gy / CHUNK_SIZE);
  return {
    cx,
    cy,
    x: gx - cx * CHUNK_SIZE,
    y: gy - cy * CHUNK_SIZE,
    color,
    seq,
  };
}

export class WorldCanvasPvpProtocol implements Protocol<
  PvpCanvasState,
  PvpPaintMove
> {
  readonly name = NAME;

  initialState(ctx: ProtocolContext): PvpCanvasState {
    return {
      digest: blake2b256(protocolDomain(NAME)),
      cells: [],
      paintCount: 0,
      appliedSeqA: 0,
      appliedSeqB: 0,
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
    if (!Array.isArray(move.cells) || move.cells.length > MAX_BATCH_CELLS) {
      throw new Error("world-canvas-pvp: illegal batch");
    }
    let digest = state.digest;
    let paintCount = state.paintCount;
    let appliedSeqA = state.appliedSeqA;
    let appliedSeqB = state.appliedSeqB;
    const cells = state.cells.slice();
    for (const c of move.cells) {
      if (!isLegalCell(c)) throw new Error("world-canvas-pvp: illegal paint");
      // Idempotent fold gate: a cell folds exactly once per seat. A re-sent or stale cell —
      // `seq` at or below the seat's cursor — is SKIPPED identically on both parties (the gate
      // reads only the shared, co-signed cursor), so the rolling digest stays in lockstep no
      // matter how the at-least-once buffer re-proposes. This is the parity guarantee.
      const applied = by === "A" ? appliedSeqA : appliedSeqB;
      if (c.seq <= applied) continue;
      if (by === "A") appliedSeqA = c.seq;
      else appliedSeqB = c.seq;
      digest = rollingDigest(blake2b256, digest, cellDelta(c, by));
      paintCount += 1;
      cells.push({
        gx: c.cx * CHUNK_SIZE + c.x,
        gy: c.cy * CHUNK_SIZE + c.y,
        color: c.color,
        by,
        seq: paintCount,
        pseq: c.seq,
      });
    }
    const capped =
      cells.length > MAX_RENDER_CELLS
        ? cells.slice(cells.length - MAX_RENDER_CELLS)
        : cells;
    return {
      ...state,
      digest,
      cells: capped,
      paintCount,
      appliedSeqA,
      appliedSeqB,
    };
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

  /** Bot autopilot: continue THIS seat's stroke as a bounded random WALK, emitting a short
   *  RUN of cells per co-sign — a coherent wandering line near wherever the seat last drew
   *  (including right where you handed the wheel back), instead of scattered dots. Seat A
   *  draws blue, seat B light purple. */
  randomMove(
    state: PvpCanvasState,
    by: Party,
    rng: () => number,
  ): PvpPaintMove {
    const recent = recentCellsBy(state.cells, by);
    let gx: number;
    let gy: number;
    let dx: number;
    let dy: number;
    if (recent.length >= 1) {
      gx = recent[0].gx;
      gy = recent[0].gy;
      dx =
        recent.length === 2
          ? clampStep(recent[0].gx - recent[1].gx)
          : Math.floor(rng() * 3) - 1;
      dy =
        recent.length === 2
          ? clampStep(recent[0].gy - recent[1].gy)
          : Math.floor(rng() * 3) - 1;
    } else {
      gx = (by === "A" ? 0 : 70) + Math.floor(rng() * 60);
      gy = Math.floor(rng() * 90);
      dx = 1;
      dy = 0;
    }
    const color = by === "A" ? 13 : 15; // Sui blue vs light purple, like the solo seats
    // Continue this seat's seq from the co-signed cursor so the run is always fresh and
    // strictly increasing — never overlapping a prior run (it would be skipped as a re-send).
    let seq = by === "A" ? state.appliedSeqA : state.appliedSeqB;
    const cells: PvpCellMove[] = [];
    for (let i = 0; i < BOT_RUN; i++) {
      // Wander: occasionally turn, and never stall in place.
      if (rng() < 0.35) {
        dx += Math.floor(rng() * 3) - 1;
        dy += Math.floor(rng() * 3) - 1;
      }
      dx = clampStep(dx);
      dy = clampStep(dy);
      if (dx === 0 && dy === 0) dx = 1;
      gx += dx;
      gy += dy;
      seq += 1;
      cells.push(toCellMove(gx, gy, color, seq));
    }
    return { cells };
  }
}
