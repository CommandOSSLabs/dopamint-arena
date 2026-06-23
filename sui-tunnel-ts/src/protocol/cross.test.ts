import { test } from "node:test";
import assert from "node:assert/strict";
import {
  laneKind,
  hazardsAt,
  isLethal,
  destOf,
  COLUMN_COUNT,
  SPAWN_COL,
} from "./cross.ts";
import { CrossProtocol, WIN_LANE, TICK_CAP, MIN_STAKE } from "./cross.ts";
import type { CrossState, CrossMove } from "./cross.ts";

test("laneKind cycles grass,grass,road,road,water,rails,grass,grass after lane 2", () => {
  assert.equal(laneKind(0), "grass");
  assert.equal(laneKind(1), "grass");
  assert.equal(laneKind(2), "road");
  assert.equal(laneKind(3), "road");
  assert.equal(laneKind(4), "water");
  assert.equal(laneKind(5), "rails");
  assert.equal(laneKind(6), "grass");
  assert.equal(laneKind(7), "grass");
  assert.equal(laneKind(8), "road");
});

test("grass is never lethal", () => {
  for (let t = 0n; t < 50n; t++) {
    assert.equal(isLethal(123n, SPAWN_COL, 0, t), false);
    assert.equal(isLethal(123n, 0, 1, t), false);
  }
});

test("hazardsAt is deterministic for the same (seed,lane,tick)", () => {
  const a = hazardsAt(777n, 2, 9n);
  const b = hazardsAt(777n, 2, 9n);
  assert.deepEqual(a, b);
});

test("water is inverted: lethal exactly when NOT on a log span", () => {
  // For some tick, find a water cell and assert lethality == not(covered by a log).
  const seed = 999n;
  const lane = 4; // water
  assert.equal(laneKind(lane), "water");
  const tick = 13n;
  const spans = hazardsAt(seed, lane, tick);
  for (let col = 0; col < COLUMN_COUNT; col++) {
    const c = col + 0.5;
    const onLog = spans.some(
      (s) =>
        [c, c - COLUMN_COUNT, c + COLUMN_COUNT].some(
          (cc) => cc > s.center - s.half && cc < s.center + s.half,
        ),
    );
    assert.equal(isLethal(seed, col, lane, tick), !onLog);
  }
});

test("destOf clamps to the board", () => {
  assert.deepEqual(destOf(3, 4, "north"), [4, 4]);
  assert.deepEqual(destOf(3, 4, "south"), [2, 4]);
  assert.deepEqual(destOf(0, 4, "south"), [0, 4]); // lane clamps at 0
  assert.deepEqual(destOf(3, 8, "east"), [3, 8]); // col clamps at COLUMN_COUNT-1
  assert.deepEqual(destOf(3, 0, "west"), [3, 0]); // col clamps at 0
});

// ============================================
// TASK 2: CrossProtocol tests
// ============================================

const CTX = { tunnelId: "0xabc123", initialBalances: { a: MIN_STAKE, b: MIN_STAKE } };

function playout(p: CrossProtocol, seedRng: () => number): CrossState {
  let s = p.initialState(CTX);
  let guard = 0;
  while (!p.isTerminal(s) && guard < Number(TICK_CAP) + 5) {
    const by = s.tick % 2n === 0n ? "A" : "B";
    const move = p.randomMove(s, by, seedRng);
    if (!move) break;
    s = p.applyMove(s, move, by);
    guard++;
  }
  return s;
}

test("initialState locks the total and starts at tick 0 with two spawned chickens", () => {
  const p = new CrossProtocol();
  const s = p.initialState(CTX);
  assert.equal(s.tick, 0n);
  assert.equal(s.total, MIN_STAKE * 2n);
  assert.equal(s.balanceA + s.balanceB, s.total);
  assert.equal(s.players.length, 2);
  assert.equal(s.winner, null);
});

test("encodeState is canonical: identical states encode to identical bytes", () => {
  const p = new CrossProtocol();
  const a = p.applyMove(p.initialState(CTX), { dirA: "north", dirB: "north" }, "A");
  const b = p.applyMove(p.initialState(CTX), { dirA: "north", dirB: "north" }, "A");
  assert.deepEqual(Array.from(p.encodeState(a)), Array.from(p.encodeState(b)));
});

test("different states encode to different bytes (tick advances)", () => {
  const p = new CrossProtocol();
  const s0 = p.initialState(CTX);
  const s1 = p.applyMove(s0, { dirA: "north" }, "A");
  assert.notDeepEqual(Array.from(p.encodeState(s0)), Array.from(p.encodeState(s1)));
});

test("balances are conserved across a full random playout", () => {
  const p = new CrossProtocol();
  let s = p.initialState(CTX);
  const rng = mulberry32ForTest(42);
  for (let i = 0; i < 400 && !p.isTerminal(s); i++) {
    const by = s.tick % 2n === 0n ? "A" : "B";
    const m = p.randomMove(s, by, rng) as CrossMove;
    s = p.applyMove(s, m, by);
    assert.equal(s.balanceA + s.balanceB, s.total, `tick ${s.tick}`);
  }
});

test("every random playout terminates and pays the full pot (or pushes)", () => {
  const p = new CrossProtocol();
  for (let seed = 0; seed < 8; seed++) {
    const s = playout(p, mulberry32ForTest(seed));
    assert.equal(p.isTerminal(s), true, `seed ${seed} did not terminate`);
    const { a, b } = p.balances(s);
    assert.equal(a + b, s.total);
    if (s.winner === "A") assert.equal(a, s.total);
    else if (s.winner === "B") assert.equal(b, s.total);
    else {
      assert.equal(a, s.total / 2n); // push
      assert.equal(b, s.total / 2n);
    }
  }
});

test("applyMove throws once the game is terminal", () => {
  const p = new CrossProtocol();
  // Force a winner: drive A north repeatedly along a safe column path is non-trivial,
  // so instead assert the guard via a synthesized terminal state.
  const s = p.initialState(CTX);
  const terminal: CrossState = { ...s, winner: "A", balanceA: s.total, balanceB: 0n };
  assert.throws(() => p.applyMove(terminal, { dirA: "north" }, "A"));
});

test("simultaneous WIN_LANE arrival with equal score is a push, not an A-win", () => {
  const p = new CrossProtocol();
  // Both chickens one hop from the finish, dead even — the exact dead-heat case.
  // Lane WIN_LANE is grass (always safe), so both hops land and both arrive this tick.
  const deadHeat: CrossState = {
    ...p.initialState(CTX),
    tick: 10n,
    players: [
      { lane: WIN_LANE - 1, col: SPAWN_COL, score: WIN_LANE - 1, invulnTicks: 0 },
      { lane: WIN_LANE - 1, col: SPAWN_COL, score: WIN_LANE - 1, invulnTicks: 0 },
    ],
  };
  const next = p.applyMove(deadHeat, { dirA: "north", dirB: "north" }, "A");
  assert.equal(next.players[0].lane >= WIN_LANE, true);
  assert.equal(next.players[1].lane >= WIN_LANE, true);
  assert.equal(next.winner, null); // dead heat ⇒ push, matching the TICK_CAP tie path
  assert.equal(next.balanceA, deadHeat.balanceA); // push: stakes unchanged, no payout
  assert.equal(next.balanceA + next.balanceB, next.total);
});

test("randomMove carries only the acting seat's hop (2-party model)", () => {
  const p = new CrossProtocol();
  const s = p.initialState(CTX);
  const a = p.randomMove(s, "A", mulberry32ForTest(1)) as CrossMove;
  assert.equal(a.dirB, undefined, "A's update must not carry B's dir");
  const b = p.randomMove(s, "B", mulberry32ForTest(1)) as CrossMove;
  assert.equal(b.dirA, undefined, "B's update must not carry A's dir");
});

// Local deterministic RNG for tests (mirrors the protocol's internal one).
function mulberry32ForTest(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
