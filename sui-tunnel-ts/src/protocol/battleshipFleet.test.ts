import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BATTLESHIP_CELL_COUNT,
  FLEET_CELLS,
  isLegalBoard,
  placeFleetRandom,
  placementsToBoard,
  shipCellCount,
} from "./battleshipFleet";
import { mulberry32 } from "../sim/rng";

test("placeFleetRandom yields a legal 17-cell board", () => {
  const rng = mulberry32(1);
  for (let i = 0; i < 50; i++) {
    const board = placementsToBoard(placeFleetRandom(rng));
    assert.equal(board.length, BATTLESHIP_CELL_COUNT);
    assert.equal(shipCellCount(board), FLEET_CELLS);
    assert.equal(isLegalBoard(board), true);
  }
});

test("isLegalBoard rejects a short fleet (the legal-fleet hole)", () => {
  const board = new Uint8Array(BATTLESHIP_CELL_COUNT); // zero ships
  assert.equal(isLegalBoard(board), false);
});

test("isLegalBoard rejects touching ships", () => {
  const board = new Uint8Array(BATTLESHIP_CELL_COUNT);
  // two 1-cell stubs diagonally adjacent — illegal regardless of counts
  board[0] = 1;
  board[11] = 1;
  assert.equal(isLegalBoard(board), false);
});
