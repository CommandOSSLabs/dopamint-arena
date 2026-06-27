import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "../core/bytes";
import { computeCommitment } from "../core/commitment";
import { CELL_COUNT } from "./battleshipFleet";
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
