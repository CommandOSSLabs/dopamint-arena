import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRID_W,
  GRID_H,
  CELL_FLOOR,
  CELL_WALL,
  CELL_CRATE,
  idx,
  isBorder,
  isPillar,
  buildGrid,
  BombItProtocol,
  BOMB_IT_TICK_CAP,
  BOMB_IT_MIN_STAKE,
  BLAST_RADIUS,
  FUSE_TICKS,
  SPAWN_B,
  dest,
  canMoveTo,
  blastCellsFor,
  resolveExplosions,
  type BombItBomb,
  type BombItPlayer,
  type BombItMove,
  type BombItState,
} from "./bombIt";

test("border ring and interior even-even cells are walls", () => {
  assert.equal(isBorder(0, 3), true);
  assert.equal(isBorder(GRID_H - 1, GRID_W - 1), true);
  assert.equal(isBorder(4, 4), false);
  assert.equal(isPillar(2, 2), true);
  assert.equal(isPillar(1, 1), false); // spawn cell is floor
});

test("buildGrid: border + lattice are walls, spawns are floor", () => {
  const g = buildGrid(123n);
  assert.equal(g.length, GRID_W * GRID_H);
  for (let c = 0; c < GRID_W; c++) {
    assert.equal(g[idx(0, c)], CELL_WALL);
    assert.equal(g[idx(GRID_H - 1, c)], CELL_WALL);
  }
  assert.equal(g[idx(2, 2)], CELL_WALL); // pillar
  assert.equal(g[idx(1, 1)], CELL_FLOOR); // spawn A
  assert.equal(g[idx(SPAWN_B.row, SPAWN_B.col)], CELL_FLOOR); // spawn B
});

test("buildGrid keeps the spawn escape L crate-free", () => {
  const g = buildGrid(987654n);
  const escapeL: Array<[number, number]> = [
    [1, 1],
    [1, 2],
    [2, 1],
    [SPAWN_B.row, SPAWN_B.col],
    [SPAWN_B.row, SPAWN_B.col - 1],
    [SPAWN_B.row - 1, SPAWN_B.col],
  ];
  for (const [r, c] of escapeL) {
    assert.notEqual(g[idx(r, c)], CELL_CRATE, `(${r},${c}) must be crate-free`);
  }
});

test("buildGrid is 180°-rotationally symmetric and seed-deterministic", () => {
  const g = buildGrid(42n);
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      assert.equal(
        g[idx(r, c)],
        g[idx(GRID_H - 1 - r, GRID_W - 1 - c)],
        `(${r},${c}) mirror`,
      );
    }
  }
  assert.deepEqual(Array.from(buildGrid(42n)), Array.from(buildGrid(42n)));
});

const deadFar: BombItPlayer = { row: 8, col: 8, alive: false };

test("dest steps north/south/east/west; bomb/stay do not move", () => {
  assert.deepEqual(dest(3, 4, "north"), [2, 4]);
  assert.deepEqual(dest(3, 4, "south"), [4, 4]);
  assert.deepEqual(dest(3, 4, "east"), [3, 5]);
  assert.deepEqual(dest(3, 4, "west"), [3, 3]);
  assert.deepEqual(dest(3, 4, "bomb"), [3, 4]);
  assert.deepEqual(dest(3, 4, "stay"), [3, 4]);
});

test("canMoveTo blocks walls, crates, bombs, the other player, and off-board", () => {
  const g = buildGrid(7n);
  // (0,*) is a wall border.
  assert.equal(canMoveTo(g, [], deadFar, 0, 1), false);
  assert.equal(canMoveTo(g, [], deadFar, -1, 1), false);
  // floor cell (1,1) is open.
  assert.equal(canMoveTo(g, [], deadFar, 1, 1), true);
  // a bomb blocks entry.
  const bomb: BombItBomb = { row: 1, col: 1, fuse: FUSE_TICKS, owner: "A" };
  assert.equal(canMoveTo(g, [bomb], deadFar, 1, 1), false);
  // the other LIVING player blocks entry.
  const other: BombItPlayer = { row: 1, col: 1, alive: true };
  assert.equal(canMoveTo(g, [], other, 1, 1), false);
});

test("blastCellsFor: + cross, stops at walls, includes-and-stops at first crate", () => {
  const g = new Uint8Array(GRID_W * GRID_H); // all floor
  g[idx(3, 5)] = CELL_WALL; // wall east of the bomb at (3,3)
  g[idx(1, 3)] = CELL_CRATE; // crate north of the bomb
  const cells = blastCellsFor(g, { row: 3, col: 3, fuse: 0, owner: "A" });
  assert.ok(cells.includes(idx(3, 3))); // center
  assert.ok(cells.includes(idx(3, 4))); // east radius 1
  assert.ok(!cells.includes(idx(3, 5))); // wall blocks east radius 2 (and is not destroyed)
  assert.ok(cells.includes(idx(2, 3))); // north radius 1
  assert.ok(cells.includes(idx(1, 3))); // crate is included...
  assert.ok(!cells.includes(idx(0, 3))); // ...but stops propagation past it
});

test("resolveExplosions detonates fuse<=0, destroys crates, chains bombs in a clear line", () => {
  const g = new Uint8Array(GRID_W * GRID_H); // all floor
  g[idx(1, 3)] = CELL_CRATE; // crate in A's NORTH arm (distance 2), NOT between the bombs
  const bombs: BombItBomb[] = [
    { row: 3, col: 3, fuse: 0, owner: "A" }, // detonates now
    { row: 3, col: 5, fuse: FUSE_TICKS, owner: "B" }, // 2 east on a clear line -> chains
  ];
  const { cells, remaining } = resolveExplosions(g, bombs);
  assert.equal(remaining.length, 0); // both gone (B chained via the clear east arm)
  assert.equal(g[idx(1, 3)], CELL_FLOOR); // crate destroyed (north arm)
  assert.ok(cells.has(idx(3, 5))); // B's bomb cell is in A's blast
});

test("a crate shields a bomb behind it: blast stops at the crate, no chain", () => {
  const g = new Uint8Array(GRID_W * GRID_H);
  g[idx(3, 4)] = CELL_CRATE; // between A(3,3) and B(3,5)
  const bombs: BombItBomb[] = [
    { row: 3, col: 3, fuse: 0, owner: "A" },
    { row: 3, col: 5, fuse: FUSE_TICKS, owner: "B" }, // shielded behind the crate
  ];
  const { cells, remaining } = resolveExplosions(g, bombs);
  assert.equal(g[idx(3, 4)], CELL_FLOOR); // crate destroyed
  assert.ok(!cells.has(idx(3, 5))); // blast stopped at the crate
  assert.equal(remaining.length, 1); // B survives
  assert.equal(remaining[0].owner, "B");
});

test("resolveExplosions leaves un-fused bombs untouched", () => {
  const g = new Uint8Array(GRID_W * GRID_H);
  const bombs: BombItBomb[] = [{ row: 3, col: 3, fuse: 3, owner: "A" }];
  const { cells, remaining } = resolveExplosions(g, bombs);
  assert.equal(remaining.length, 1);
  assert.equal(cells.size, 0);
});

const CTX = {
  tunnelId: "0xabc123",
  initialBalances: { a: BOMB_IT_MIN_STAKE, b: BOMB_IT_MIN_STAKE },
};

test("initialState locks the total, spawns two living players, no bombs/winner", () => {
  const p = new BombItProtocol();
  const s = p.initialState(CTX);
  assert.equal(s.tick, 0n);
  assert.equal(s.total, BOMB_IT_MIN_STAKE * 2n);
  assert.equal(s.balanceA + s.balanceB, s.total);
  assert.equal(s.players[0].alive, true);
  assert.equal(s.players[1].alive, true);
  assert.equal(s.bombs.length, 0);
  assert.equal(s.winner, null);
  assert.equal(s.grid.length, GRID_W * GRID_H);
});

test("encodeState is canonical and starts with the domain tag", () => {
  const p = new BombItProtocol();
  const a = p.initialState(CTX);
  const b = p.initialState(CTX);
  assert.deepEqual(Array.from(p.encodeState(a)), Array.from(p.encodeState(b)));
  const tag = new TextEncoder().encode("sui_tunnel::proto::bomb_it.v1");
  assert.deepEqual(
    Array.from(p.encodeState(a).slice(0, tag.length)),
    Array.from(tag),
  );
});

test("encodeState differs when a player position differs", () => {
  const p = new BombItProtocol();
  const s = p.initialState(CTX);
  const moved = {
    ...s,
    players: [{ ...s.players[0], col: 2 }, s.players[1]] as typeof s.players,
  };
  assert.notDeepEqual(
    Array.from(p.encodeState(s)),
    Array.from(p.encodeState(moved)),
  );
});

test("balances return the stored split; isTerminal tracks winner", () => {
  const p = new BombItProtocol();
  const s = p.initialState(CTX);
  assert.deepEqual(p.balances(s), {
    a: BOMB_IT_MIN_STAKE,
    b: BOMB_IT_MIN_STAKE,
  });
  assert.equal(p.isTerminal(s), false);
  assert.equal(p.isTerminal({ ...s, winner: "A" }), true);
  assert.equal(p.isTerminal({ ...s, winner: "draw" }), true);
});

/** Run the world forward applying the SAME move object both seats would (only one field set). */
function advance(
  p: BombItProtocol,
  s: BombItState,
  m: BombItMove,
): BombItState {
  const by = m.a !== undefined ? "A" : "B";
  return p.applyMove(s, m, by);
}

test("a move into a wall is a deterministic no-op (stay)", () => {
  const p = new BombItProtocol();
  const s = p.initialState(CTX); // A at (1,1); north -> (0,1) is wall
  const n = advance(p, s, { a: "north" });
  assert.equal(n.players[0].row, 1);
  assert.equal(n.players[0].col, 1);
  assert.equal(n.tick, 1n);
});

test("dropping a bomb places one fused bomb; a second drop is capped", () => {
  const p = new BombItProtocol();
  let s = p.initialState(CTX);
  s = advance(p, s, { a: "bomb" });
  assert.equal(s.bombs.length, 1);
  assert.equal(s.bombs[0].owner, "A");
  assert.equal(s.bombs[0].fuse, FUSE_TICKS - 1); // one world advance has elapsed
  s = advance(p, s, { b: "stay" }); // B's tick
  s = advance(p, s, { a: "bomb" }); // A still has a live bomb -> capped, no new bomb
  assert.equal(s.bombs.filter((b) => b.owner === "A").length, 1);
});

test("a bomb kills a player standing in its blast and pays the other the full pot", () => {
  const p = new BombItProtocol();
  // Build a controlled state: A and B adjacent, A drops, fuse runs out.
  const base = p.initialState(CTX);
  let s: BombItState = {
    ...base,
    players: [spawnAt(1, 1), spawnAt(1, 2)], // B one cell east of A (radius 2 reaches it)
    grid: clearInterior(base.grid),
  };
  s = advance(p, s, { a: "bomb" }); // A drops at (1,1), now standing on it
  // Let the fuse burn down with both seats staying; A should also die (self-blast).
  for (let i = 0; i < FUSE_TICKS; i++) {
    s = advance(p, s, s.tick % 2n === 0n ? { a: "stay" } : { b: "stay" });
    if (p.isTerminal(s)) break;
  }
  assert.equal(p.isTerminal(s), true);
  // A stood on the bomb -> A dies; B at (1,2) is within radius 2 -> B dies too -> draw.
  assert.equal(s.winner, "draw");
  assert.equal(s.balanceA + s.balanceB, s.total);
});

test("only the opponent dying yields a decisive winner + flipped balances", () => {
  const p = new BombItProtocol();
  const base = p.initialState(CTX);
  let s: BombItState = {
    ...base,
    players: [spawnAt(1, 1), spawnAt(1, 2)],
    grid: clearInterior(base.grid),
  };
  // A drops then runs out of the blast (west is wall, so go nowhere useful — instead place,
  // then move A away on its next turns). A at (1,1): east blocked later by bomb; move south.
  s = advance(p, s, { a: "bomb" }); // bomb at (1,1); fuse FUSE_TICKS-1
  s = advance(p, s, { b: "stay" });
  s = advance(p, s, { a: "south" }); // A -> (2,1), out of a radius-2 horizontal/vertical? (2,1) is 1 south of bomb -> still in blast!
  // (2,1) is within the bomb's south arm (radius 2). Move A further south next turn.
  s = advance(p, s, { b: "stay" });
  s = advance(p, s, { a: "south" }); // A -> (3,1): 2 south of bomb, still within radius 2.
  s = advance(p, s, { b: "stay" });
  s = advance(p, s, { a: "south" }); // A -> (4,1): 3 south, OUT of blast.
  // burn the remaining fuse with stays
  while (!p.isTerminal(s)) {
    s = advance(p, s, s.tick % 2n === 0n ? { a: "stay" } : { b: "stay" });
  }
  assert.equal(s.winner, "A"); // B died at (1,2); A escaped
  assert.deepEqual(p.balances(s), { a: s.total, b: 0n });
});

test("applyMove throws on a terminal state and on a forged opponent field", () => {
  const p = new BombItProtocol();
  const s = p.initialState(CTX);
  assert.throws(() => p.applyMove({ ...s, winner: "A" }, { a: "stay" }, "A"));
  assert.throws(() => p.applyMove(s, { b: "bomb" }, "A")); // A may not submit B's action
  assert.throws(() => p.applyMove(s, { a: "north" }, "B")); // B may not submit A's action
});

test("a full hunter-bot playout terminates (kill or cap) and conserves balances every tick", () => {
  const p = new BombItProtocol();
  let s = p.initialState(CTX);
  const rng = mulberry32ForTest(5);
  let guard = 0;
  while (!p.isTerminal(s) && guard < Number(BOMB_IT_TICK_CAP) + 5) {
    const by = s.tick % 2n === 0n ? "A" : "B";
    const m = p.randomMove(s, by, rng) as BombItMove;
    s = p.applyMove(s, m, by);
    assert.equal(s.balanceA + s.balanceB, s.total, `tick ${s.tick}`);
    guard++;
  }
  assert.equal(p.isTerminal(s), true);
  const { a, b } = p.balances(s);
  assert.equal(a + b, s.total);
});

test("hunter bot may bomb an in-line opponent when rng allows an attack", () => {
  const p = new BombItProtocol();
  const base = p.initialState(CTX);
  const s: BombItState = {
    ...base,
    players: [spawnAt(1, 1), spawnAt(1, 3)],
    grid: clearInterior(base.grid),
  };
  let sawBomb = false;
  for (let seed = 0; seed < 64; seed++) {
    const m = p.randomMove(s, "A", mulberry32ForTest(seed)) as BombItMove;
    if (m.a === "bomb") {
      sawBomb = true;
      break;
    }
  }
  assert.ok(sawBomb, "expected at least one seed to bomb an in-line opponent");
});

test("hunter bot flees an imminent blast instead of bombing", () => {
  const p = new BombItProtocol();
  const base = p.initialState(CTX);
  const s: BombItState = {
    ...base,
    players: [spawnAt(1, 1), spawnAt(5, 5)],
    grid: clearInterior(base.grid),
    bombs: [{ row: 1, col: 2, fuse: 1, owner: "B" }],
  };
  const m = p.randomMove(s, "A", mulberry32ForTest(1)) as BombItMove;
  assert.notEqual(m.a, "bomb");
  assert.notEqual(m.a, "stay");
});

test("a hunter-bot match drops bombs and destroys crates", () => {
  const p = new BombItProtocol();
  let s = p.initialState(CTX);
  const rng = mulberry32ForTest(5);
  const crates0 = Array.from(s.grid).filter((c) => c === CELL_CRATE).length;
  let bombs = 0;
  let guard = 0;
  while (!p.isTerminal(s) && guard < Number(BOMB_IT_TICK_CAP) + 5) {
    const by = s.tick % 2n === 0n ? "A" : "B";
    const m = p.randomMove(s, by, rng) as BombItMove;
    if (m.a === "bomb" || m.b === "bomb") bombs++;
    s = p.applyMove(s, m, by);
    guard++;
  }
  const cratesEnd = Array.from(s.grid).filter((c) => c === CELL_CRATE).length;
  assert.ok(bombs > 0, "bots must drop at least one bomb over a match");
  assert.ok(
    crates0 - cratesEnd > 0,
    "bots must destroy at least one crate over a match",
  );
});

// --- local test helpers ---
function spawnAt(row: number, col: number) {
  return { row, col, alive: true };
}
/** A board with the same walls/pillars as a built grid but no crates (clearer scenarios). */
function clearInterior(grid: Uint8Array): Uint8Array {
  const g = Uint8Array.from(grid);
  for (let i = 0; i < g.length; i++) if (g[i] === CELL_CRATE) g[i] = CELL_FLOOR;
  return g;
}
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
