import { test } from "node:test";
import assert from "node:assert/strict";

import { CELL_COUNT, placeFleetRandom, placementsToBoard } from "./fleet.ts";
import {
  SALT_BYTES,
  commitBoard,
  proveCell,
  randomSalts,
  verifyCell,
} from "./merkle.ts";

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

/** Deterministic per-cell salts so commitments are reproducible across runs. */
function saltsFromSeed(seed: number): Uint8Array[] {
  const rng = mulberry32(seed);
  return Array.from({ length: CELL_COUNT }, () => {
    const s = new Uint8Array(SALT_BYTES);
    for (let i = 0; i < SALT_BYTES; i++) s[i] = Math.floor(rng() * 256);
    return s;
  });
}

test("commitBoard is deterministic and yields a 32-byte root", () => {
  const board = placementsToBoard(placeFleetRandom(mulberry32(7)));
  const salts = saltsFromSeed(1);
  const a = commitBoard(board, salts);
  const b = commitBoard(board, salts);
  assert.equal(a.root.length, 32);
  assert.deepEqual(a.root, b.root);
});

test("every cell proves and verifies against the root", () => {
  const board = placementsToBoard(placeFleetRandom(mulberry32(11)));
  const salts = saltsFromSeed(2);
  const c = commitBoard(board, salts);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    const proof = proveCell(c, cell);
    assert.equal(proof.length, 7, `proof length for cell ${cell}`);
    assert.equal(
      verifyCell(c.root, cell, board[cell] === 1, salts[cell], proof),
      true,
      `cell ${cell} verifies`,
    );
  }
});

test("verifyCell rejects a flipped hit, a wrong salt, and a tampered proof", () => {
  const board = placementsToBoard(placeFleetRandom(mulberry32(13)));
  const salts = saltsFromSeed(3);
  const c = commitBoard(board, salts);
  const shipCell = board.findIndex((v) => v === 1);
  const proof = proveCell(c, shipCell);

  // Lie about the result for a committed cell.
  assert.equal(
    verifyCell(c.root, shipCell, false, salts[shipCell], proof),
    false,
  );
  // Right result, wrong salt.
  assert.equal(
    verifyCell(c.root, shipCell, true, saltsFromSeed(999)[shipCell], proof),
    false,
  );
  // Tamper a sibling in the proof.
  const bad = proof.map((p, i) => (i === 0 ? p.map((b) => b ^ 0xff) : p));
  assert.equal(verifyCell(c.root, shipCell, true, salts[shipCell], bad), false);
});

test("a proof from one board does not verify against another board's root", () => {
  const salts = saltsFromSeed(4);
  const c1 = commitBoard(
    placementsToBoard(placeFleetRandom(mulberry32(21))),
    salts,
  );
  const c2 = commitBoard(
    placementsToBoard(placeFleetRandom(mulberry32(22))),
    saltsFromSeed(5),
  );
  const proof = proveCell(c1, 0);
  assert.equal(verifyCell(c2.root, 0, false, salts[0], proof), false);
});

test("randomSalts returns one fresh 32-byte salt per cell", () => {
  const salts = randomSalts();
  assert.equal(salts.length, CELL_COUNT);
  assert.equal(salts[0].length, SALT_BYTES);
  // Overwhelmingly likely distinct.
  assert.notDeepEqual(salts[0], salts[1]);
});
