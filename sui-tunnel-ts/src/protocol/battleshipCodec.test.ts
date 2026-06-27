import assert from "node:assert/strict";
import { test } from "node:test";
import { CELL_COUNT } from "./battleshipFleet";
import { BattleshipMove } from "./battleship";
import { battleshipMoveCodec } from "./battleshipCodec";

function roundTrip(m: BattleshipMove): BattleshipMove {
  return battleshipMoveCodec.decode(
    JSON.parse(JSON.stringify(battleshipMoveCodec.encode(m))),
  );
}

test("every move round-trips through the codec", () => {
  const commitment = new Uint8Array(32).fill(9);
  const board = new Uint8Array(CELL_COUNT).fill(1);
  const salt = new Uint8Array(16).fill(3);

  assert.deepEqual(roundTrip({ kind: "commit", commitment }), {
    kind: "commit",
    commitment,
  });
  assert.deepEqual(roundTrip({ kind: "shoot", cell: 42 }), {
    kind: "shoot",
    cell: 42,
  });
  assert.deepEqual(roundTrip({ kind: "answer", isHit: true }), {
    kind: "answer",
    isHit: true,
  });
  assert.deepEqual(roundTrip({ kind: "answer", isHit: false, next: 7 }), {
    kind: "answer",
    isHit: false,
    next: 7,
  });
  assert.deepEqual(roundTrip({ kind: "reveal_board", board, salt }), {
    kind: "reveal_board",
    board,
    salt,
  });
  assert.deepEqual(roundTrip({ kind: "resign" }), { kind: "resign" });
});
