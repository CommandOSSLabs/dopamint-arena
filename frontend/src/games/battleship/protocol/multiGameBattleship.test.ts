import test from "node:test";
import assert from "node:assert/strict";
import {
  MultiGameBattleshipProtocol,
  type MultiGameBattleshipState,
} from "./multiGameBattleship";
import {
  nextMove,
  randomFleetSecret,
  type FleetSecret,
} from "../engine/selfPlay";

/** Deterministic LCG so the multi-game playthrough is reproducible. */
function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function freshSecrets(rng: () => number): { A: FleetSecret; B: FleetSecret } {
  return { A: randomFleetSecret(rng), B: randomFleetSecret(rng) };
}

const conserved = (s: MultiGameBattleshipState, total: bigint): boolean =>
  s.inner.balanceA + s.inner.balanceB === total;

/**
 * Drive one full inner game to a winner on the wrapper. For game 2+ the inner game
 * is already `over`, so the FIRST commit triggers the rematch reset; then `nextMove`
 * (which owns both fleet secrets) drives the rest.
 */
function playOneGame(
  proto: MultiGameBattleshipProtocol,
  start: MultiGameBattleshipState,
  secrets: { A: FleetSecret; B: FleetSecret },
  rng: () => number,
  total: bigint,
): MultiGameBattleshipState {
  let state = start;
  if (state.inner.phase === "over") {
    state = proto.applyMove(
      state,
      { type: "commit", root: secrets.A.commitment.root },
      "A",
    );
    assert.ok(conserved(state, total), "conserved across the rematch commit");
  }
  let guard = 0;
  while (state.inner.winner === 0) {
    if (++guard > 5000) throw new Error("game did not terminate");
    const driven = nextMove(state.inner, secrets, rng, "hard");
    if (!driven) break;
    state = proto.applyMove(state, driven.move, driven.by);
    assert.ok(conserved(state, total), "conserved on every step");
  }
  return state;
}

test("plays many games on one tunnel, conserving balances every step", () => {
  const proto = new MultiGameBattleshipProtocol(100n);
  const total = 2000n;
  const rng = rngFrom(42);
  let state = proto.initialState({
    tunnelId: "t",
    initialBalances: { a: 1000n, b: 1000n },
  });
  const games = 5;
  for (let g = 0; g < games; g++) {
    state = playOneGame(proto, state, freshSecrets(rng), rng, total);
    assert.notEqual(state.inner.winner, 0, "each game produced a winner");
  }
  // gamesPlayed counts completed games BEHIND the current one; the 5th is current.
  assert.equal(state.gamesPlayed, games - 1);
  assert.ok(
    conserved(state, total),
    "net result still sums to the locked total",
  );
});

test("a finished game is not terminal while both sides can fund the next", () => {
  const proto = new MultiGameBattleshipProtocol(100n);
  const rng = rngFrom(7);
  let state = proto.initialState({
    tunnelId: "t",
    initialBalances: { a: 1000n, b: 1000n },
  });
  state = playOneGame(proto, state, freshSecrets(rng), rng, 2000n);
  assert.notEqual(state.inner.winner, 0, "a game finished");
  assert.equal(
    proto.isTerminal(state),
    false,
    "session continues — both can fund",
  );
});

test("a finished game IS terminal once a side cannot fund the next stake", () => {
  // Stake equals A's whole balance: after one loss a side can't cover another.
  const proto = new MultiGameBattleshipProtocol(1000n);
  const rng = rngFrom(7);
  let state = proto.initialState({
    tunnelId: "t",
    initialBalances: { a: 1000n, b: 1000n },
  });
  state = playOneGame(proto, state, freshSecrets(rng), rng, 2000n);
  // One side is now at 0 (or 2000), so it can't fund a 1000 stake → session terminal.
  assert.equal(proto.isTerminal(state), true);
});

test("a rematch commit carries balances forward and bumps gamesPlayed", () => {
  const proto = new MultiGameBattleshipProtocol(100n);
  const rng = rngFrom(13);
  let state = proto.initialState({
    tunnelId: "t",
    initialBalances: { a: 1000n, b: 1000n },
  });
  state = playOneGame(proto, state, freshSecrets(rng), rng, 2000n);
  const afterG1 = { a: state.inner.balanceA, b: state.inner.balanceB };
  assert.equal(state.gamesPlayed, 0);

  const next = freshSecrets(rng);
  state = proto.applyMove(
    state,
    { type: "commit", root: next.A.commitment.root },
    "A",
  );
  assert.equal(state.gamesPlayed, 1, "gamesPlayed bumped on the rematch");
  assert.equal(state.inner.phase, "awaitingCommits", "fresh board");
  assert.deepEqual(
    { a: state.inner.balanceA, b: state.inner.balanceB },
    afterG1,
    "balances carried forward verbatim",
  );
});

test("only a commit can start the next game after one ends", () => {
  const proto = new MultiGameBattleshipProtocol(100n);
  const rng = rngFrom(99);
  let state = proto.initialState({
    tunnelId: "t",
    initialBalances: { a: 1000n, b: 1000n },
  });
  state = playOneGame(proto, state, freshSecrets(rng), rng, 2000n);
  assert.throws(() => proto.applyMove(state, { type: "shoot", cell: 0 }, "A"));
});

test("encodeState is deterministic and distinguishes gamesPlayed", () => {
  const proto = new MultiGameBattleshipProtocol(100n);
  const s = proto.initialState({
    tunnelId: "t",
    initialBalances: { a: 1000n, b: 1000n },
  });
  assert.deepEqual(proto.encodeState(s), proto.encodeState(s));
  const bumped: MultiGameBattleshipState = { inner: s.inner, gamesPlayed: 1 };
  assert.notDeepEqual(proto.encodeState(s), proto.encodeState(bumped));
});
