import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CELL_COUNT,
  FLEET,
  FLEET_CELLS,
  fleetIsLegal,
  isLegalBoard,
  placeFleetRandom,
  placementCells,
  placementsToBoard,
  shipCellCount,
  type Placement,
} from "./fleet.ts";

/** Deterministic PRNG so placement tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hand-built legal fleet: ships on even rows, separated by an empty row. */
const LEGAL_FLEET: Placement[] = [
  { id: "carrier", cell: 0, orient: "H" }, // row 0, cols 0..4
  { id: "battleship", cell: 20, orient: "H" }, // row 2, cols 0..3
  { id: "cruiser", cell: 40, orient: "H" }, // row 4, cols 0..2
  { id: "submarine", cell: 60, orient: "H" }, // row 6, cols 0..2
  { id: "destroyer", cell: 80, orient: "H" }, // row 8, cols 0..1
];

function boardOf(cells: number[]): Uint8Array {
  const b = new Uint8Array(CELL_COUNT);
  for (const c of cells) b[c] = 1;
  return b;
}

test("the standard fleet is five ships totalling 17 cells", () => {
  assert.equal(FLEET.length, 5);
  assert.equal(FLEET_CELLS, 17);
});

test("placementCells lists the run, and returns null when it runs off the board", () => {
  assert.deepEqual(
    placementCells({ id: "destroyer", cell: 0, orient: "H" }),
    [0, 1],
  );
  assert.deepEqual(
    placementCells({ id: "cruiser", cell: 0, orient: "V" }),
    [0, 10, 20],
  );
  // destroyer starting at col 9 would need col 10 — off the board.
  assert.equal(placementCells({ id: "destroyer", cell: 9, orient: "H" }), null);
});

test("a separated fleet is legal and covers exactly 17 cells", () => {
  assert.equal(fleetIsLegal(LEGAL_FLEET), true);
  assert.equal(shipCellCount(placementsToBoard(LEGAL_FLEET)), FLEET_CELLS);
});

test("fleetIsLegal rejects overlap, diagonal touching, and a missing ship", () => {
  const overlap = LEGAL_FLEET.map((p) =>
    p.id === "destroyer" ? { ...p, cell: 0 } : p,
  );
  assert.equal(fleetIsLegal(overlap), false);

  // Destroyer at row 1 col 5 touches the carrier (row 0 cols 0..4) only diagonally.
  const touchingDiagonally = LEGAL_FLEET.map((p) =>
    p.id === "destroyer" ? { ...p, cell: 15, orient: "V" as const } : p,
  );
  assert.equal(fleetIsLegal(touchingDiagonally), false);

  assert.equal(fleetIsLegal(LEGAL_FLEET.slice(0, 4)), false);
});

test("isLegalBoard accepts a clean fleet and rejects bad shapes", () => {
  assert.equal(isLegalBoard(placementsToBoard(LEGAL_FLEET)), true);

  // 16 cells — wrong count.
  assert.equal(
    isLegalBoard(
      boardOf([0, 1, 2, 3, 4, 20, 21, 22, 23, 40, 41, 42, 60, 61, 62, 80]),
    ),
    false,
  );

  // Two ships fused into one bent/over-long component (carrier + battleship touching).
  const fused = boardOf([
    0, 1, 2, 3, 4, 10, 11, 12, 13, 40, 41, 42, 60, 61, 62, 80, 81,
  ]);
  assert.equal(isLegalBoard(fused), false);

  // An L-shaped 5-cell component is 4-connected but not straight.
  const ell = boardOf([
    0, 1, 2, 12, 22, 40, 41, 42, 60, 61, 62, 80, 81, 4, 24, 44, 64,
  ]);
  assert.equal(isLegalBoard(ell), false);
});

test("placeFleetRandom always yields a legal fleet and a legal board", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const placements = placeFleetRandom(mulberry32(seed));
    assert.equal(
      fleetIsLegal(placements),
      true,
      `fleet legal for seed ${seed}`,
    );
    assert.equal(
      isLegalBoard(placementsToBoard(placements)),
      true,
      `board legal for seed ${seed}`,
    );
  }
});
