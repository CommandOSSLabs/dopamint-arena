/**
 * Flicker-fix parity test. The PvP paint flicker fix persists a painter's optimistic live stroke at
 * a finite render seq just above the applied cursor (so the ink shows at pointer-up instead of
 * vanishing until its co-signed cell round-trips back) — and it MUST stay render-only, never
 * touching the co-signed digest/per-seat cursor. This pins both halves of that contract:
 *   - the optimistic stroke RENDERS before confirmation (a finite seq above the applied cursor but
 *     below the next real co-signed cell), so it is drawn, not dropped, yet is cleanly overdrawn;
 *   - the later confirmed cell folds idempotently — applying it again is a total no-op (no digest /
 *     no per-seat cursor change), and the painter (who optimistically rendered) and the peer (who
 *     did not) end byte-identical. The optimistic render carries zero protocol effect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { liveStrokePersistSeq } from "./liveStroke";
import {
  WorldCanvasPvpProtocol,
  CHUNK_SIZE,
  type PvpCellMove,
} from "sui-tunnel-ts/protocol/worldCanvasPvp";

const ctx = { tunnelId: "0xworld", initialBalances: { a: 1n, b: 1n } };
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** A deterministic well-formed cell keyed purely by `seq`. */
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

test("a PvP paint live-stroke renders before confirmation, then the co-signed cell overdraws it idempotently", () => {
  // (1) RENDERS BEFORE CONFIRMATION. The PvP painter persists its optimistic stroke at a FINITE
  //     render seq just above the applied cursor — drawn the instant the pointer lifts, not dropped.
  const appliedCursor = 4;
  const optimistic = liveStrokePersistSeq(false, appliedCursor);
  assert.ok(Number.isFinite(optimistic)); // it is persisted/rendered, not skipped
  assert.ok(optimistic > appliedCursor); //   ...above everything already on the wall
  assert.ok(optimistic < appliedCursor + 1); //  ...but BELOW the next real co-signed cell
  // Solo keeps its own ink pinned on top (its cells never return via syncPaints).
  assert.equal(
    liveStrokePersistSeq(true, appliedCursor),
    Number.MAX_SAFE_INTEGER,
  );

  // (2) RENDER-ONLY → PARITY. The optimistic render never folds a move, so the co-signed state is
  //     byte-identical on the painter (who optimistically rendered cell 5) and the peer (who did
  //     not); only the REAL co-signed cell folds, exactly once, on both seats.
  const proto = new WorldCanvasPvpProtocol();
  const base = proto.applyMove(
    proto.initialState(ctx),
    { cells: seqRun(1, 4) },
    "A",
  );
  const painter = proto.applyMove(base, { cells: [cellForSeq(5)] }, "A");
  const peer = proto.applyMove(base, { cells: [cellForSeq(5)] }, "A");
  assert.equal(hex(proto.encodeState(painter)), hex(proto.encodeState(peer)));
  assert.equal(painter.appliedSeqA, 5); // folded exactly once
  assert.equal(painter.cells.length, base.cells.length + 1);

  // (3) NO-OP OVERDRAW. The confirmed cell arriving AGAIN (the at-least-once buffer re-sending, or
  //     the optimistic copy's seq being re-seen) changes neither the digest nor the per-seat cursor.
  const overdrawn = proto.applyMove(painter, { cells: [cellForSeq(5)] }, "A");
  assert.equal(
    hex(proto.encodeState(overdrawn)),
    hex(proto.encodeState(painter)),
  );
  assert.equal(overdrawn.appliedSeqA, painter.appliedSeqA);
  assert.equal(overdrawn.cells.length, painter.cells.length);
});
