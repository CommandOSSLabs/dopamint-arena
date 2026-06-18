import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRID_W,
  GRID_H,
  CELL_FLOOR,
  CELL_WALL,
  CELL_CRATE,
  idx,
  isBorder,
  isPillar,
  buildGrid,
} from "./bombIt.ts";

test("border ring and interior even-even cells are walls", () => {
  assert.equal(isBorder(0, 3), true);
  assert.equal(isBorder(8, 8), true);
  assert.equal(isBorder(4, 4), false);
  assert.equal(isPillar(2, 2), true);
  assert.equal(isPillar(1, 1), false); // spawn cell is floor
});

test("buildGrid: border + lattice are walls, spawns are floor", () => {
  const g = buildGrid(123n);
  assert.equal(g.length, GRID_W * GRID_H);
  for (let c = 0; c < GRID_W; c++) {
    assert.equal(g[idx(0, c)], CELL_WALL);
    assert.equal(g[idx(GRID_H - 1, c)], CELL_WALL);
  }
  assert.equal(g[idx(2, 2)], CELL_WALL); // pillar
  assert.equal(g[idx(1, 1)], CELL_FLOOR); // spawn A
  assert.equal(g[idx(7, 7)], CELL_FLOOR); // spawn B
});

test("buildGrid keeps the spawn escape L crate-free", () => {
  const g = buildGrid(987654n);
  for (const [r, c] of [[1, 1], [1, 2], [2, 1], [7, 7], [7, 6], [6, 7]]) {
    assert.notEqual(g[idx(r, c)], CELL_CRATE, `(${r},${c}) must be crate-free`);
  }
});

test("buildGrid is 180°-rotationally symmetric and seed-deterministic", () => {
  const g = buildGrid(42n);
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      assert.equal(g[idx(r, c)], g[idx(GRID_H - 1 - r, GRID_W - 1 - c)], `(${r},${c}) mirror`);
    }
  }
  assert.deepEqual(Array.from(buildGrid(42n)), Array.from(buildGrid(42n)));
});
