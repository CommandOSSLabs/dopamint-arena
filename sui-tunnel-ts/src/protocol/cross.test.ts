import { test } from "node:test";
import assert from "node:assert/strict";
import {
  laneKind,
  hazardsAt,
  isLethal,
  destOf,
  COLUMN_COUNT,
  SPAWN_COL,
} from "./cross.ts";

test("laneKind cycles grass,grass,road,road,water,rails,grass,grass after lane 2", () => {
  assert.equal(laneKind(0), "grass");
  assert.equal(laneKind(1), "grass");
  assert.equal(laneKind(2), "road");
  assert.equal(laneKind(3), "road");
  assert.equal(laneKind(4), "water");
  assert.equal(laneKind(5), "rails");
  assert.equal(laneKind(6), "grass");
  assert.equal(laneKind(7), "grass");
  assert.equal(laneKind(8), "road");
});

test("grass is never lethal", () => {
  for (let t = 0n; t < 50n; t++) {
    assert.equal(isLethal(123n, SPAWN_COL, 0, t), false);
    assert.equal(isLethal(123n, 0, 1, t), false);
  }
});

test("hazardsAt is deterministic for the same (seed,lane,tick)", () => {
  const a = hazardsAt(777n, 2, 9n);
  const b = hazardsAt(777n, 2, 9n);
  assert.deepEqual(a, b);
});

test("water is inverted: lethal exactly when NOT on a log span", () => {
  // For some tick, find a water cell and assert lethality == not(covered by a log).
  const seed = 999n;
  const lane = 4; // water
  const tick = 13n;
  const spans = hazardsAt(seed, lane, tick);
  for (let col = 0; col < COLUMN_COUNT; col++) {
    const c = col + 0.5;
    const onLog = spans.some(
      (s) =>
        [c, c - COLUMN_COUNT, c + COLUMN_COUNT].some(
          (cc) => cc > s.center - s.half && cc < s.center + s.half,
        ),
    );
    assert.equal(isLethal(seed, col, lane, tick), !onLog);
  }
});

test("destOf clamps to the board", () => {
  assert.deepEqual(destOf(3, 4, "north"), [4, 4]);
  assert.deepEqual(destOf(3, 4, "south"), [2, 4]);
  assert.deepEqual(destOf(0, 4, "south"), [0, 4]); // lane clamps at 0
  assert.deepEqual(destOf(3, 8, "east"), [3, 8]); // col clamps at COLUMN_COUNT-1
  assert.deepEqual(destOf(3, 0, "west"), [3, 0]); // col clamps at 0
});
