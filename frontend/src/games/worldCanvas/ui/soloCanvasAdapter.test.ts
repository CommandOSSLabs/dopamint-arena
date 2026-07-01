/**
 * Solo canvas adapter: turns the worker's PvpCell[] stream into the props the rich WorldCanvas
 * chrome needs — a bot marker per active seat and a per-seat leaderboard tally. The tally must be
 * cap-safe (the render stream drops its oldest cells), which is why it reads the monotonic per-seat
 * `pseq` rather than counting array entries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveSoloAgents,
  deriveSoloPainters,
  SEAT_ADDRESS,
} from "./soloCanvasAdapter";
import type { PvpCell } from "sui-tunnel-ts/protocol/worldCanvasPvp";

function cell(by: "A" | "B", seq: number, pseq: number, gx = seq, gy = 0): PvpCell {
  return { gx, gy, color: 1, by, seq, pseq };
}

test("deriveSoloPainters counts per-seat via pseq (cap-safe)", () => {
  // Oldest seat-A cells dropped by the render cap; only pseq 40 + 41 remain, so the tally is 41.
  const view = [cell("A", 100, 40), cell("B", 101, 12), cell("A", 102, 41)];
  const painters = deriveSoloPainters(view);
  assert.equal(painters.get(SEAT_ADDRESS.A)?.cells, 41);
  assert.equal(painters.get(SEAT_ADDRESS.B)?.cells, 12);
  assert.equal(painters.get(SEAT_ADDRESS.A)?.label, "Bot A");
  assert.equal(painters.get(SEAT_ADDRESS.B)?.label, "Bot B");
});

test("deriveSoloAgents marks both seats when auto, drops seat A when manual", () => {
  const view = [cell("A", 1, 1, 10, 20), cell("B", 2, 1, 30, 40)];
  const both = deriveSoloAgents(view, true);
  assert.deepEqual(
    both.map((a) => a.painter).sort(),
    ["bot-a", "bot-b"],
  );
  const manual = deriveSoloAgents(view, false);
  assert.deepEqual(
    manual.map((a) => a.painter),
    ["bot-b"],
  );
  // The seat-B marker anchors on that seat's most-recent cell.
  assert.equal(manual[0].gx, 30);
  assert.equal(manual[0].gy, 40);
});

test("empty view yields no agents and zero-cell painters", () => {
  assert.deepEqual(deriveSoloAgents([], true), []);
  const painters = deriveSoloPainters([]);
  assert.equal(painters.get(SEAT_ADDRESS.A)?.cells, 0);
});
