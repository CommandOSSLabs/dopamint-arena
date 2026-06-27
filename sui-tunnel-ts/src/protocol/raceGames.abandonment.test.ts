// Channel-close safety review (SolEng) — Chicken Cross + Bomb It (the "race/reaction" games).
//
// Both are REAL cross-wallet PvP with money at risk (usePvpChickenCross.ts / usePvpBombIt.ts
// open a funded tunnel via pvpMatchHook.ts; stake S per seat) — NOT stubs. Both open with
// penaltyAmount = 0 and have no game-aware referee, so settlement is cooperative or a
// GAME-BLIND `force_close_after_timeout` (latest co-signed balances + a flat penalty of ZERO).
//
// These tests pin the MONEY-FLOW PRECONDITION that makes Kostas's abandonment attack (F1)
// apply here: the entire stake swing is concentrated in a SINGLE co-signed transition — every
// non-terminal co-signed state is balance-even (S, S), and only the decisive tick (the finish-
// line crossing / the killing blast) flips it to (2S, 0) / (0, 2S). Because of that, a losing
// seat that withholds its co-signature on that one transition keeps the even state, and the
// penalty-0 game-blind close pays it out — the loser keeps the stake it was about to lose.
//
// These are GREEN: the invariant genuinely HOLDS. The RED consequence (the honest winner is
// stranded on the even state; the chain pays it out) is the SAME mechanism proven generically
// in ticTacToe.abandonment.test.ts (the engine refuses to advance without an ACK) and
// sui_tunnel/tests/game_close_safety_tests.move (penalty-0 force_close pays the even state) —
// it is not duplicated here. The point of these tests is to prove the precondition is real for
// each game, so the team can see F1 is fleet-wide, not specific to tic-tac-toe.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CrossProtocol, MIN_STAKE, TICK_CAP } from "./cross";
import {
  BombItProtocol,
  BOMB_IT_MIN_STAKE,
  CELL_CRATE,
  CELL_FLOOR,
  type BombItMove,
  type BombItState,
} from "./bombIt";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Chicken Cross — drive self-play to a decisive finish; assert the invariant at every tick.
test("cross: every non-terminal state is balance-even; the pot flips in ONE decisive tick", () => {
  const p = new CrossProtocol();
  const S = MIN_STAKE;
  let sawDecisive = false;

  for (let seed = 0; seed < 24 && !sawDecisive; seed++) {
    const rng = mulberry32(seed);
    let s = p.initialState({ tunnelId: `0xcross${seed}`, initialBalances: { a: S, b: S } });
    let guard = 0;
    while (!p.isTerminal(s) && guard < Number(TICK_CAP) + 5) {
      // INVARIANT: while the race is undecided, the whole stake is still split evenly — there
      // is no intermediate co-signed state in which a leader is already "owed" the pot.
      assert.equal(s.balanceA, S, `seed ${seed} tick ${s.tick}`);
      assert.equal(s.balanceB, S, `seed ${seed} tick ${s.tick}`);

      const by = s.tick % 2n === 0n ? "A" : "B";
      const move = p.randomMove(s, by, rng);
      if (!move) break;
      const prev = s;
      s = p.applyMove(s, move, by);
      guard++;

      if (p.isTerminal(s) && s.winner) {
        // The ONE decisive transition flips the entire pot; the state just before it was even.
        assert.equal(prev.balanceA, S);
        assert.equal(prev.balanceB, S);
        assert.equal(s.winner === "A" ? s.balanceA : s.balanceB, S * 2n);
        assert.equal(s.winner === "A" ? s.balanceB : s.balanceA, 0n);
        sawDecisive = true;
      }
    }
  }
  assert.ok(sawDecisive, "expected at least one decisive race to demonstrate the single-move pot flip");
});

// Bomb It — a controlled forced kill (A bombs, escapes; trapped B dies) shows the same shape.
const advance = (p: BombItProtocol, s: BombItState, m: BombItMove): BombItState =>
  p.applyMove(s, m, m.a !== undefined ? "A" : "B");

function spawnAt(row: number, col: number) {
  return { row, col, alive: true };
}
function clearInterior(grid: Uint8Array): Uint8Array {
  const g = Uint8Array.from(grid);
  for (let i = 0; i < g.length; i++) if (g[i] === CELL_CRATE) g[i] = CELL_FLOOR;
  return g;
}

test("bomb-it: balances stay even until the killing tick, which flips the pot in ONE move", () => {
  const p = new BombItProtocol();
  const S = BOMB_IT_MIN_STAKE;
  const base = p.initialState({ tunnelId: "0xbomb", initialBalances: { a: S, b: S } });
  // B sits one cell east of A (inside A's future blast); a crate-free interior keeps it controlled.
  let s: BombItState = {
    ...base,
    players: [spawnAt(1, 1), spawnAt(1, 2)],
    grid: clearInterior(base.grid),
  };

  // A drops a bomb and walks 3 cells south (out of a radius-2 blast); B stays, trapped.
  const opening: BombItMove[] = [
    { a: "bomb" },
    { b: "stay" },
    { a: "south" },
    { b: "stay" },
    { a: "south" },
    { b: "stay" },
    { a: "south" },
  ];
  for (const m of opening) {
    assert.equal(s.balanceA, S); // even before every pre-kill move
    assert.equal(s.balanceB, S);
    s = advance(p, s, m);
  }

  // Burn the remaining fuse with stays until the blast resolves and B dies.
  let preKill: BombItState | null = null;
  while (!p.isTerminal(s)) {
    assert.equal(s.balanceA, S); // still even right up to the killing tick
    assert.equal(s.balanceB, S);
    preKill = s;
    s = advance(p, s, s.tick % 2n === 0n ? { a: "stay" } : { b: "stay" });
  }

  assert.equal(s.winner, "A");
  assert.equal(s.balanceA, S * 2n); // the killing tick flips the whole pot at once...
  assert.equal(s.balanceB, 0n);
  assert.ok(preKill && preKill.balanceA === S && preKill.balanceB === S, "...from an even state");
});
