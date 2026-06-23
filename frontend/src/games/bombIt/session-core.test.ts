import { test } from "node:test";
import assert from "node:assert/strict";
// Runtime SDK imports use RELATIVE .ts paths (tsx ignores the vite alias / tsconfig paths).
import {
  BombItProtocol,
  BOMB_IT_MIN_STAKE,
  BOMB_IT_TICK_CAP,
} from "../../../../sui-tunnel-ts/src/protocol/bombIt.ts";
// Type-only: tsx erases these, so the test stays free of the SDK's runtime crypto deps
// (OffchainTunnel pulls @noble/hashes, unresolvable from the frontend package).
import type {
  BombItState,
  BombItMove,
} from "../../../../sui-tunnel-ts/src/protocol/bombIt.ts";
import type { OffchainTunnel } from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { deriveView, sessionResult, stepSession } from "./session-core.ts";

const CTX = {
  tunnelId: "0xfeed",
  initialBalances: { a: BOMB_IT_MIN_STAKE, b: BOMB_IT_MIN_STAKE },
};

/** Deterministic PRNG so the self-play game shape is reproducible across runs. */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("deriveView flattens grid, players, bombs, and balances to plain values", () => {
  const p = new BombItProtocol();
  const v = deriveView(p.initialState(CTX));
  assert.equal(v.grid.length, 81);
  assert.equal(v.players.length, 2);
  assert.equal(typeof v.balanceA, "number");
  assert.equal(v.bombs.length, 0);
  assert.equal(v.winner, null);
});

test("sessionResult reports the winning seat (and draws as draw)", () => {
  const p = new BombItProtocol();
  const s = p.initialState(CTX);
  assert.equal(sessionResult({ ...s, winner: "A" }), "A");
  assert.equal(sessionResult({ ...s, winner: "B" }), "B");
  assert.equal(sessionResult({ ...s, winner: "draw" }), "draw");
  assert.equal(sessionResult(s), "draw"); // in-progress (winner null) -> neutral draw
});

test("stepSession alternates seats, advances to a terminal result, one tick per step", () => {
  const p = new BombItProtocol();
  // Real protocol advances the state; the SDK's OffchainTunnel only adds co-signing (verified in
  // the SDK suite). stepSession's own job — parity seat-pick, legal random move, advance-or-stop —
  // is exercised against the REAL protocol, so the boundary under test is not faked.
  let state: BombItState = p.initialState(CTX);
  const advancedBy: ("A" | "B")[] = [];
  const tunnel = {
    get state() {
      return state;
    },
    step(move: BombItMove, by: "A" | "B") {
      state = p.applyMove(state, move, by);
      advancedBy.push(by);
    },
  } as unknown as OffchainTunnel<BombItState, BombItMove>;

  const rng = seededRng(0xb0b17);
  let steps = 0;
  while (stepSession(p, tunnel, rng)) steps += 1;

  assert.ok(p.isTerminal(state), "game reaches a terminal state");
  assert.equal(advancedBy.length, steps, "exactly one tick advanced per step");
  assert.ok(steps > 0, "at least one tick was played");
  assert.ok(
    steps <= Number(BOMB_IT_TICK_CAP),
    "the tick cap bounds the game length",
  );
  // Seats strictly alternate by tick parity: A on even ticks, B on odd.
  assert.deepEqual(advancedBy.slice(0, 4), ["A", "B", "A", "B"]);
  // The terminal step does no advance: a further call is a no-op false.
  assert.equal(stepSession(p, tunnel, rng), false);
});
