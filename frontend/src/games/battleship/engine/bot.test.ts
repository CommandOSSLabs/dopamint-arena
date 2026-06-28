import { test } from "node:test";
import assert from "node:assert/strict";

import { BOT_CONFIGS, BOT_DIFFICULTIES, pickShot } from "./bot.ts";
import { CELL_COUNT, cellAt, colOf, rowOf } from "./fleet.ts";
import { BattleshipProtocol } from "sui-tunnel-ts/protocol/battleship.ts";
import type { BattleshipState, BattleshipShotResult as ShotResult } from "sui-tunnel-ts/protocol/battleship.ts";
import { playToCompletion, randomFleetSecret } from "./selfPlay.ts";

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

/** A minimal state exposing only the shot history `pickShot` reads (shooter = A, defender = B). */
function shotsAtB(shots: ShotResult[]): BattleshipState {
  return { shotsAtA: [], shotsAtB: shots } as unknown as BattleshipState;
}

const orthoNeighbors = (cell: number): number[] => {
  const r = rowOf(cell);
  const c = colOf(cell);
  return [
    [r - 1, c],
    [r + 1, c],
    [r, c - 1],
    [r, c + 1],
  ]
    .filter(([rr, cc]) => rr >= 0 && rr < 10 && cc >= 0 && cc < 10)
    .map(([rr, cc]) => cellAt(rr, cc));
};

const parityOf = (cell: number): number => (rowOf(cell) + colOf(cell)) % 2;

test("every difficulty fires distinct, in-range cells and never repeats", () => {
  for (const difficulty of BOT_DIFFICULTIES) {
    const rng = mulberry32(7);
    const fired: ShotResult[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < CELL_COUNT; i++) {
      const cell = pickShot(shotsAtB(fired), "A", rng, BOT_CONFIGS[difficulty]);
      assert.ok(cell >= 0 && cell < CELL_COUNT, `${difficulty} in range`);
      assert.ok(!seen.has(cell), `${difficulty} never re-fires ${cell}`);
      seen.add(cell);
      fired.push({ cell, isHit: false }); // feed misses so it keeps hunting
    }
    assert.equal(seen.size, CELL_COUNT, `${difficulty} covers the whole board`);
  }
});

test("easy and normal chase a fresh hit by firing an orthogonal neighbour", () => {
  const hit = 44;
  const neighbours = new Set(orthoNeighbors(hit));
  for (const difficulty of ["easy", "normal"] as const) {
    for (let seed = 1; seed <= 20; seed++) {
      const cell = pickShot(
        shotsAtB([{ cell: hit, isHit: true }]),
        "A",
        mulberry32(seed),
        BOT_CONFIGS[difficulty],
      );
      assert.ok(neighbours.has(cell), `${difficulty} seed ${seed} chased`);
    }
  }
});

test("normal restricts blind hunting to one checkerboard colour", () => {
  const rng = mulberry32(5);
  for (let i = 0; i < 40; i++) {
    const cell = pickShot(shotsAtB([]), "A", rng, BOT_CONFIGS.normal);
    assert.equal(parityOf(cell), 0, "even-parity hunt cell");
  }
});

test("easy hunts the whole board, not just one colour", () => {
  const rng = mulberry32(9);
  const fired: ShotResult[] = [];
  const parities = new Set<number>();
  for (let i = 0; i < 40; i++) {
    const cell = pickShot(shotsAtB(fired), "A", rng, BOT_CONFIGS.easy);
    parities.add(parityOf(cell));
    fired.push({ cell, isHit: false });
  }
  assert.deepEqual([...parities].sort(), [0, 1], "easy fires both colours");
});

test("hard concentrates fire on a wounded ship, extending the line of hits", () => {
  // Hits at 11 and 12 (a horizontal pair); the most-likely cells are the ends, 10 and 13.
  const ends = new Set([10, 13]);
  for (let seed = 1; seed <= 20; seed++) {
    const cell = pickShot(
      shotsAtB([
        { cell: 11, isHit: true },
        { cell: 12, isHit: true },
      ]),
      "A",
      mulberry32(seed),
      BOT_CONFIGS.hard,
    );
    assert.ok(ends.has(cell), `seed ${seed} extended the line (got ${cell})`);
  }
});

test("hard stops shooting around a ship it has already sunk", () => {
  // A destroyer sunk at 0-1: cell 2 is a miss, the left/top ends are the board edge.
  // Its only open neighbours (10, 11, 12) must never be fired again.
  const deadZone = new Set([10, 11, 12]);
  for (let seed = 1; seed <= 20; seed++) {
    const cell = pickShot(
      shotsAtB([
        { cell: 0, isHit: true },
        { cell: 1, isHit: true },
        { cell: 2, isHit: false },
      ]),
      "A",
      mulberry32(seed),
      BOT_CONFIGS.hard,
    );
    assert.ok(
      !deadZone.has(cell),
      `seed ${seed} avoided the sunk ship (${cell})`,
    );
  }
});

test("a hard self-play game still terminates with a decisive, conserved result", () => {
  const proto = new BattleshipProtocol(100n);
  const ctx = { tunnelId: "t1", initialBalances: { a: 1000n, b: 1000n } };
  for (let seed = 1; seed <= 10; seed++) {
    const secrets = {
      A: randomFleetSecret(mulberry32(seed * 2)),
      B: randomFleetSecret(mulberry32(seed * 2 + 1)),
    };
    const final = playToCompletion(
      proto,
      proto.initialState(ctx),
      secrets,
      mulberry32(seed),
      "hard",
    );
    assert.ok(
      final.winner === 1 || final.winner === 2,
      `seed ${seed} decisive`,
    );
    assert.equal(final.phase, "over");
    assert.equal(final.balanceA + final.balanceB, final.total);
  }
});
