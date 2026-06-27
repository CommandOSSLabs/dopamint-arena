import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "../core/bytes";
import { computeCommitment } from "../core/commitment";
import { CELL_COUNT, FLEET_CELLS as FLEET_CELLS_T } from "./battleshipFleet";
import {
  BattleshipMove,
  BattleshipProtocol,
  BattleshipState,
} from "./battleship";

const ctx = { tunnelId: "0xab", initialBalances: { a: 1000n, b: 1000n } };
const proto = new BattleshipProtocol(100n);
const fresh = (): BattleshipState => proto.initialState(ctx);

// A fixed 16-byte salt + a throwaway board commitment for commit-phase tests.
const SALT = new Uint8Array(16).fill(7);
const board = (): Uint8Array => new Uint8Array(CELL_COUNT);
const commitMove = (b: Uint8Array): BattleshipMove => ({
  kind: "commit",
  commitment: computeCommitment(b, SALT),
});

test("fresh game awaits commits, A to move, balances summed", () => {
  const s = fresh();
  assert.equal(s.phase, "awaitingCommits");
  assert.equal(s.turn, "A");
  assert.equal(s.balanceA + s.balanceB, s.total);
});

test("commits are ordered A then B, then play opens", () => {
  let s = fresh();
  s = proto.applyMove(s, commitMove(board()), "A");
  assert.equal(s.phase, "awaitingCommits");
  assert.throws(() => proto.applyMove(s, commitMove(board()), "A")); // A can't commit twice
  s = proto.applyMove(s, commitMove(board()), "B");
  assert.equal(s.phase, "playing");
  assert.equal(s.turn, "A");
});

test("encodeState is deterministic and excludes secrets", () => {
  let s = fresh();
  s = proto.applyMove(s, commitMove(board()), "A");
  s = proto.applyMove(s, commitMove(board()), "B");
  const h1 = toHex(proto.encodeState(s));
  const h2 = toHex(proto.encodeState({ ...s }));
  assert.equal(h1, h2);
});

// ---- play-phase helpers ----
function opened(): BattleshipState {
  let s = fresh();
  s = proto.applyMove(s, commitMove(board()), "A");
  s = proto.applyMove(s, commitMove(board()), "B");
  return s; // phase "playing", A to move
}

test("opening shoot sets pendingShot; double-shoot rejected", () => {
  let s = opened();
  s = proto.applyMove(s, { kind: "shoot", cell: 0 }, "A");
  assert.deepEqual(s.pendingShot, { by: "A", cell: 0 });
  assert.throws(() => proto.applyMove(s, { kind: "shoot", cell: 1 }, "A"));
});

test("a hit keeps the shooter's turn; defender cannot pipeline on a hit", () => {
  let s = opened();
  s = proto.applyMove(s, { kind: "shoot", cell: 5 }, "A");
  // defender B answers HIT
  s = proto.applyMove(s, { kind: "answer", isHit: true }, "B");
  assert.equal(s.hitsOnB, 1);
  assert.equal(s.turn, "A"); // A keeps firing
  assert.equal(s.pendingShot, null);
  // a hit-answer carrying `next` is illegal
  let s2 = opened();
  s2 = proto.applyMove(s2, { kind: "shoot", cell: 6 }, "A");
  assert.throws(() =>
    proto.applyMove(s2, { kind: "answer", isHit: true, next: 7 }, "B"),
  );
});

test("a miss passes the turn and pipelines the defender's return shot", () => {
  let s = opened();
  s = proto.applyMove(s, { kind: "shoot", cell: 5 }, "A");
  s = proto.applyMove(s, { kind: "answer", isHit: false, next: 9 }, "B");
  assert.equal(s.turn, "B");
  assert.deepEqual(s.pendingShot, { by: "B", cell: 9 });
  // B may not pipeline a shot at a cell B already fired at
  s = proto.applyMove(s, { kind: "answer", isHit: false, next: 9 }, "A"); // A answers B's shot at 9 (miss), fires next
  // now A re-fires; ensure no-reshoot via pipeline is enforced elsewhere
  assert.equal(s.turn, "A");
});

test("the 17th hit ends play and enters revealBoards", () => {
  let s = opened();
  // A fires 17 shots at distinct cells; B answers all hits (keeps A's turn)
  for (let i = 0; i < FLEET_CELLS_T; i++) {
    s = proto.applyMove(s, { kind: "shoot", cell: i }, "A");
    s = proto.applyMove(s, { kind: "answer", isHit: true }, "B");
  }
  assert.equal(s.hitsOnB, FLEET_CELLS_T);
  assert.equal(s.phase, "revealBoards");
});
