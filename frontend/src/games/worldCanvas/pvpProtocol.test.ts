/**
 * Determinism/parity tests for the World Canvas PvP protocol — the co-sign contract that
 * keeps two co-signing clients byte-identical. Every other `Protocol<>` in the repo has a
 * co-located determinism test; this pins the same guarantees here:
 *   - same ordered co-signed stream -> same {@link WorldCanvasPvpProtocol.encodeState} digest
 *     on both seats (the rolling digest IS the co-signed truth);
 *   - the per-seat `seq` gate makes a re-sent/stale batch a deterministic no-op on both sides
 *     (digest + `appliedSeq` unchanged), without ever over-skipping a genuinely fresh cell;
 *   - an illegal batch (over `MAX_BATCH_CELLS`, or carrying a malformed cell) is rejected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  WorldCanvasPvpProtocol,
  CHUNK_SIZE,
  MAX_BATCH_CELLS,
  type PvpCellMove,
} from "./pvpProtocol";

type Seat = "A" | "B";

/** A `ProtocolContext` is structurally just the tunnel id + locked starting balances. */
const ctx = { tunnelId: "0xworld", initialBalances: { a: 1n, b: 1n } };

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** A deterministic, well-formed cell for a seat's monotonic `seq` stamp. Seats A and B paint
 *  into different chunks/colors so a mixed stream genuinely exercises both per-seat cursors. */
function paintBy(seat: Seat, seq: number): PvpCellMove {
  const spread = seq * 37;
  return {
    cx: seat === "A" ? 0 : -1,
    cy: seat === "A" ? 0 : 2,
    x: spread % CHUNK_SIZE,
    y: (spread * 3) % CHUNK_SIZE,
    color: seat === "A" ? 13 : 15,
    seq,
  };
}

/** Inclusive run of one seat's cells for seqs `from..to`. */
function runBy(seat: Seat, from: number, to: number): PvpCellMove[] {
  const cells: PvpCellMove[] = [];
  for (let s = from; s <= to; s++) cells.push(paintBy(seat, s));
  return cells;
}

/** A single seat's deterministic cell keyed purely by `seq`, so two paths that fold the same
 *  seqs fold byte-identical deltas regardless of how the batches were sliced. */
function cellForSeq(seq: number): PvpCellMove {
  return {
    cx: 0,
    cy: 0,
    x: (seq * 11) % CHUNK_SIZE,
    y: (seq * 17) % CHUNK_SIZE,
    color: seq % 16,
    seq,
  };
}

function seqRun(from: number, to: number): PvpCellMove[] {
  const cells: PvpCellMove[] = [];
  for (let s = from; s <= to; s++) cells.push(cellForSeq(s));
  return cells;
}

/** A fixed ordered stream of co-signed batches mixing both seats; each seat's `seq` is
 *  monotonic from 1. Total folded cells: A(1..3,4..6,7)=7 + B(1..2,3..5)=5 = 12. */
const COSIGNED_STREAM: { by: Seat; cells: PvpCellMove[] }[] = [
  { by: "A", cells: runBy("A", 1, 3) },
  { by: "B", cells: runBy("B", 1, 2) },
  { by: "A", cells: runBy("A", 4, 6) },
  { by: "B", cells: runBy("B", 3, 5) },
  { by: "A", cells: runBy("A", 7, 7) },
];

test("same ordered co-signed stream yields an identical digest on both seats", () => {
  const protoA = new WorldCanvasPvpProtocol();
  const protoB = new WorldCanvasPvpProtocol();
  let seatAView = protoA.initialState(ctx);
  let seatBView = protoB.initialState(ctx);
  for (const { by, cells } of COSIGNED_STREAM) {
    seatAView = protoA.applyMove(seatAView, { cells }, by);
    seatBView = protoB.applyMove(seatBView, { cells }, by);
  }

  // The co-sign parity guarantee: both parties fold the same ordered cells into the same hash.
  assert.equal(
    hex(protoA.encodeState(seatAView)),
    hex(protoB.encodeState(seatBView)),
  );
  // ...and the stream actually moved the digest off the genesis value.
  const genesis = hex(protoA.encodeState(protoA.initialState(ctx)));
  assert.notEqual(hex(protoA.encodeState(seatAView)), genesis);
  // Per-seat cursors advanced to each seat's last seq; render cells = total folded.
  assert.equal(seatAView.appliedSeqA, 7);
  assert.equal(seatAView.appliedSeqB, 5);
  assert.equal(seatAView.cells.length, 12);
  assert.deepEqual(
    { a: seatAView.appliedSeqA, b: seatAView.appliedSeqB },
    { a: seatBView.appliedSeqA, b: seatBView.appliedSeqB },
  );
});

test("a re-sent overlapping batch folds only its fresh tail, matching the fresh-only path", () => {
  const proto = new WorldCanvasPvpProtocol();
  const base = proto.applyMove(
    proto.initialState(ctx),
    { cells: seqRun(1, 8) },
    "A",
  );

  // Path X: an at-least-once re-send overlaps the cursor (5..8 already folded) then extends (9..12).
  const overlapped = proto.applyMove(base, { cells: seqRun(5, 12) }, "A");
  // Path Y: only the genuinely new tail 9..12 ever crosses the tunnel.
  const freshOnly = proto.applyMove(base, { cells: seqRun(9, 12) }, "A");

  // The re-sent 5..8 are skipped identically on both sides -> the digests are byte-identical.
  assert.equal(
    hex(proto.encodeState(overlapped)),
    hex(proto.encodeState(freshOnly)),
  );
  // The cursor advanced to the highest fresh seq, never double-counting the overlap.
  assert.equal(overlapped.appliedSeqA, 12);
  assert.equal(freshOnly.appliedSeqA, 12);
  // Exactly 12 cells render either way (8 + 4 fresh), never 8 + 8.
  assert.equal(overlapped.cells.length, 12);
  assert.equal(freshOnly.cells.length, 12);

  // Replaying the exact same stale batch again is a total no-op on every observable field.
  const replayed = proto.applyMove(overlapped, { cells: seqRun(5, 12) }, "A");
  assert.equal(
    hex(proto.encodeState(replayed)),
    hex(proto.encodeState(overlapped)),
  );
  assert.equal(replayed.appliedSeqA, overlapped.appliedSeqA);
  assert.equal(replayed.cells.length, overlapped.cells.length);
});

test("a genuinely fresh higher seq still folds: the gate is not over-skipping", () => {
  const proto = new WorldCanvasPvpProtocol();
  const base = proto.applyMove(
    proto.initialState(ctx),
    { cells: seqRun(1, 8) },
    "A",
  );
  const before = hex(proto.encodeState(base));

  const advanced = proto.applyMove(base, { cells: [cellForSeq(9)] }, "A");
  assert.notEqual(hex(proto.encodeState(advanced)), before);
  assert.equal(advanced.appliedSeqA, 9);
  assert.equal(advanced.cells.length, base.cells.length + 1);
});

test("a batch larger than MAX_BATCH_CELLS is rejected as an illegal batch", () => {
  const proto = new WorldCanvasPvpProtocol();
  const s = proto.initialState(ctx);
  const tooMany = seqRun(1, MAX_BATCH_CELLS + 1); // 129 otherwise-well-formed cells
  assert.equal(tooMany.length, MAX_BATCH_CELLS + 1);
  assert.throws(
    () => proto.applyMove(s, { cells: tooMany }, "A"),
    /illegal batch/,
  );
  // The boundary itself (exactly MAX_BATCH_CELLS) is accepted.
  assert.doesNotThrow(() =>
    proto.applyMove(s, { cells: seqRun(1, MAX_BATCH_CELLS) }, "A"),
  );
});

test("a malformed cell (out-of-range or non-integer coord/color) is rejected as illegal paint", () => {
  const proto = new WorldCanvasPvpProtocol();
  const s = proto.initialState(ctx);
  const ok = cellForSeq(1);
  // x/y outside [0, CHUNK_SIZE) and color outside [0, NUM_COLORS) each throw.
  assert.throws(
    () => proto.applyMove(s, { cells: [{ ...ok, x: -1 }] }, "A"),
    /illegal paint/,
  );
  assert.throws(
    () => proto.applyMove(s, { cells: [{ ...ok, x: CHUNK_SIZE }] }, "A"),
    /illegal paint/,
  );
  assert.throws(
    () => proto.applyMove(s, { cells: [{ ...ok, y: CHUNK_SIZE }] }, "A"),
    /illegal paint/,
  );
  assert.throws(
    () => proto.applyMove(s, { cells: [{ ...ok, color: 16 }] }, "A"),
    /illegal paint/,
  );
  assert.throws(
    () => proto.applyMove(s, { cells: [{ ...ok, color: -1 }] }, "A"),
    /illegal paint/,
  );
  // A non-integer coordinate is just as illegal as an out-of-range one.
  assert.throws(
    () => proto.applyMove(s, { cells: [{ ...ok, x: 1.5 }] }, "A"),
    /illegal paint/,
  );
});
