import test from "node:test";
import assert from "node:assert/strict";
import {
  CaroProtocol,
  caroStarterFor,
  caroNextMover,
  CARO_PRESETS,
  type CaroState,
} from "./caro";

const ctx = (a = 1000n, b = 1000n) => ({
  tunnelId: "0x1",
  initialBalances: { a, b },
});

/** Play a fixed sequence of cells, alternating from the protocol's current mover. */
function playCells(proto: CaroProtocol, s: CaroState, cells: number[]): CaroState {
  for (const cell of cells) {
    s = proto.applyMove(s, { cell }, caroNextMover(s));
  }
  return s;
}

test("ttt preset is 3x3 / 3-in-a-row; caro preset is 15x15 / 5", () => {
  assert.deepEqual(CARO_PRESETS.ttt, { boardSize: 3, winLength: 3 });
  assert.deepEqual(CARO_PRESETS.caro, { boardSize: 15, winLength: 5 });
});

test("detects a horizontal win and shifts the stake to the winner", () => {
  const p = new CaroProtocol({ boardSize: 3, winLength: 3, matchCap: 5, stake: 100n });
  let s = p.initialState(ctx());
  // A:0 B:3 A:1 B:4 A:2 -> A completes row {0,1,2}
  s = playCells(p, s, [0, 3, 1, 4, 2]);
  assert.equal(s.lastWinner, 1, "A wins");
  assert.equal(s.phase, "over");
  assert.equal(s.matchesPlayed, 1);
  assert.equal(s.balanceA, 1100n);
  assert.equal(s.balanceB, 900n);
  assert.equal(s.balanceA + s.balanceB, s.total, "balances conserve total");
});

test("detects a vertical win", () => {
  const p = new CaroProtocol({ boardSize: 3, winLength: 3, matchCap: 5 });
  let s = p.initialState(ctx());
  // A:0 B:1 A:3 B:2 A:6 -> A completes column {0,3,6}
  s = playCells(p, s, [0, 1, 3, 2, 6]);
  assert.equal(s.lastWinner, 1);
});

test("detects a diagonal win on a 5x5 board, 3-in-a-row", () => {
  const p = new CaroProtocol({ boardSize: 5, winLength: 3, matchCap: 5 });
  let s = p.initialState(ctx());
  // A:0 B:1 A:6 B:2 A:12 -> A completes diagonal {0,6,12}
  s = playCells(p, s, [0, 1, 6, 2, 12]);
  assert.equal(s.lastWinner, 1);
});

test("a full board with no line is a draw and shifts nothing", () => {
  const p = new CaroProtocol({ boardSize: 3, winLength: 3, matchCap: 5, stake: 100n });
  let s = p.initialState(ctx());
  // X O X / X O O / O X X  played in a legal alternating order, no 3-in-a-row.
  s = playCells(p, s, [0, 1, 2, 4, 3, 5, 7, 6, 8]);
  assert.equal(s.lastWinner, 3, "draw");
  assert.equal(s.balanceA, 1000n);
  assert.equal(s.balanceB, 1000n);
});

test("plays matches back-to-back with alternating starters until matchCap", () => {
  const p = new CaroProtocol({ boardSize: 3, winLength: 3, matchCap: 2, stake: 100n });
  let s = p.initialState(ctx());
  assert.equal(caroStarterFor(0), "A");
  assert.equal(caroStarterFor(1), "B");

  // Match 0: A wins via top row.
  s = playCells(p, s, [0, 3, 1, 4, 2]);
  assert.equal(s.matchesPlayed, 1);
  assert.equal(p.isTerminal(s), false, "one more match allowed");
  assert.equal(caroNextMover(s), "B", "match 1 starts with B");

  // Match 1 starts with B (board resets on the first placement).
  s = playCells(p, s, [0, 3, 1, 4, 2]); // B completes top row this time
  assert.equal(s.matchesPlayed, 2);
  assert.equal(s.lastWinner, 2, "B wins match 1");
  assert.equal(p.isTerminal(s), true, "matchCap reached");
  assert.throws(() => p.applyMove(s, { cell: 5 }, caroNextMover(s)), /game over/);
  assert.equal(s.balanceA + s.balanceB, s.total);
});

test("randomMove yields only legal moves and stops at terminal", () => {
  const p = new CaroProtocol({ boardSize: 5, winLength: 4, matchCap: 3, stake: 50n });
  let s = p.initialState(ctx());
  let rngState = 12345;
  const rng = () => ((rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let steps = 0;
  while (!p.isTerminal(s) && steps < 5000) {
    const by = caroNextMover(s);
    const mv = p.randomMove(s, by, rng);
    assert.ok(mv, "non-terminal state must offer a move");
    s = p.applyMove(s, mv!, by);
    assert.equal(s.balanceA + s.balanceB, s.total, "balances always conserve total");
    steps++;
  }
  assert.equal(p.isTerminal(s), true);
  assert.equal(s.matchesPlayed, 3, "played exactly matchCap matches");
  assert.equal(p.randomMove(s, caroNextMover(s), rng), null, "no move at terminal");
});
