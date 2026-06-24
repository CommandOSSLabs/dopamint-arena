import test from "node:test";
import assert from "node:assert/strict";
import { CrossProtocol } from "./cross";
import {
  MultiGameCrossProtocol,
  type MultiGameCrossState,
} from "./multiGameCross";

/** Deterministic LCG so playthroughs are reproducible. */
function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Conservation is on the WRAPPER's real balances, not the inner symbolic ones. */
const conserved = (s: MultiGameCrossState, total: bigint): boolean =>
  s.balanceA + s.balanceB === total;

/** Drive the current inner race to terminal via the wrapper's own bot moves. */
function playOneGame(
  proto: MultiGameCrossProtocol,
  start: MultiGameCrossState,
  rng: () => number,
  total: bigint
): MultiGameCrossState {
  let state = start;
  let guard = 0;
  while (!proto.isGameOver(state)) {
    if (++guard > 20000) throw new Error("game did not terminate");
    const by = state.inner.tick % 2n === 0n ? "A" : "B";
    const move = proto.randomMove(state, by, rng);
    if (!move) break;
    state = proto.applyMove(state, move, by);
    assert.ok(conserved(state, total), "conserved on every step");
  }
  return state;
}

test("plays many games on one tunnel, conserving balances every step", () => {
  const proto = new MultiGameCrossProtocol("0xt", 100n);
  const total = 2000n;
  const rng = rngFrom(42);
  let state = proto.initialState({
    tunnelId: "0xt",
    initialBalances: { a: 1000n, b: 1000n },
  });
  let games = 0;
  for (let g = 0; g < 5; g++) {
    state = playOneGame(proto, state, rng, total);
    assert.ok(proto.isGameOver(state), "inner game reached terminal");
    assert.ok(conserved(state, total), "conserved after the game decided");
    if (proto.isTerminal(state)) break; // stake exhausted (only if stake≈balance)
    state = proto.applyMove(state, { dirA: undefined }, "A"); // kickoff next game
    assert.ok(conserved(state, total), "conserved across the rematch kickoff");
    games++;
  }
  assert.ok(
    games >= 1,
    "played and rematched at least once (small stake, large balance)"
  );
  assert.ok(
    conserved(state, total),
    "net result still sums to the locked total"
  );
});

test("a decided game swaps EXACTLY the per-game stake; the rest stays staked", () => {
  const proto = new MultiGameCrossProtocol("0xt", 100n);
  const rng = rngFrom(13);
  let state = proto.initialState({
    tunnelId: "0xt",
    initialBalances: { a: 1000n, b: 1000n },
  });
  state = playOneGame(proto, state, rng, 2000n);
  const w = state.inner.winner;
  if (w === "A")
    assert.deepEqual(
      { a: state.balanceA, b: state.balanceB },
      { a: 1100n, b: 900n }
    );
  else if (w === "B")
    assert.deepEqual(
      { a: state.balanceA, b: state.balanceB },
      { a: 900n, b: 1100n }
    );
  else
    assert.deepEqual(
      { a: state.balanceA, b: state.balanceB },
      { a: 1000n, b: 1000n }
    ); // push
});

test("rematch re-seeds the inner game to a DIFFERENT board", () => {
  const proto = new MultiGameCrossProtocol("0xt", 100n);
  const rng = rngFrom(7);
  let state = proto.initialState({
    tunnelId: "0xt",
    initialBalances: { a: 1000n, b: 1000n },
  });
  const seedG1 = state.inner.seed;
  state = playOneGame(proto, state, rng, 2000n);
  assert.equal(
    proto.isTerminal(state),
    false,
    "small stake vs large balance — fundable"
  );
  state = proto.applyMove(state, { dirA: undefined }, "A");
  assert.equal(state.gamesPlayed, 1, "gamesPlayed bumped on the rematch");
  assert.notEqual(
    state.inner.seed,
    seedG1,
    "game 2 uses a different per-game seed"
  );
});

test("a finished game is not terminal while both sides can fund the next", () => {
  const proto = new MultiGameCrossProtocol("0xt", 100n);
  const base = new CrossProtocol().initialState({
    tunnelId: "0xt:g1",
    initialBalances: { a: 100n, b: 100n },
  });
  const pushed = { ...base, tick: 5400n, winner: null as null }; // tick-cap push
  const state: MultiGameCrossState = {
    inner: pushed,
    gamesPlayed: 0,
    balanceA: 1000n,
    balanceB: 1000n,
  };
  assert.equal(proto.isGameOver(state), true, "inner game over (tick cap)");
  assert.equal(
    proto.isTerminal(state),
    false,
    "session continues — both can fund"
  );
});

test("session IS terminal once a side cannot fund the next stake", () => {
  const proto = new MultiGameCrossProtocol("0xt", 100n);
  const base = new CrossProtocol().initialState({
    tunnelId: "0xt:g1",
    initialBalances: { a: 100n, b: 100n },
  });
  const decided = { ...base, winner: "A" as const }; // a finished (terminal) inner race
  // Exhausted: B holds less than the stake → no further game can be funded.
  const broke: MultiGameCrossState = {
    inner: decided,
    gamesPlayed: 0,
    balanceA: 1950n,
    balanceB: 50n,
  };
  assert.equal(proto.isTerminal(broke), true, "B (50) cannot fund a 100 stake");
  // Still fundable after a decided game → session continues.
  const funded: MultiGameCrossState = {
    inner: decided,
    gamesPlayed: 0,
    balanceA: 1100n,
    balanceB: 900n,
  };
  assert.equal(
    proto.isTerminal(funded),
    false,
    "both can still fund the next game"
  );
});

test("encodeState is deterministic and distinguishes gamesPlayed + domain", () => {
  const proto = new MultiGameCrossProtocol("0xt", 100n);
  const inner = new CrossProtocol();
  const s = proto.initialState({
    tunnelId: "0xt",
    initialBalances: { a: 1000n, b: 1000n },
  });
  assert.deepEqual(proto.encodeState(s), proto.encodeState(s));
  const bumped: MultiGameCrossState = { ...s, gamesPlayed: 1 };
  assert.notDeepEqual(proto.encodeState(s), proto.encodeState(bumped));
  // The multi-game encoding must never collide with the bare inner single-game encoding.
  assert.notDeepEqual(proto.encodeState(s), inner.encodeState(s.inner));
});
