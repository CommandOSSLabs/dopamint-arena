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
} from "./bombIt.ts";

test("border ring and interior even-even cells are walls", () => {
  assert.equal(isBorder(0, 3), true);
  assert.equal(isBorder(8, 8), true);
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
  assert.equal(g[idx(7, 7)], CELL_FLOOR); // spawn B
});

test("buildGrid keeps the spawn escape L crate-free", () => {
  const g = buildGrid(987654n);
  for (const [r, c] of [[1, 1], [1, 2], [2, 1], [7, 7], [7, 6], [6, 7]]) {
    assert.notEqual(g[idx(r, c)], CELL_CRATE, `(${r},${c}) must be crate-free`);
  }
});

test("buildGrid is 180°-rotationally symmetric and seed-deterministic", () => {
  const g = buildGrid(42n);
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      assert.equal(g[idx(r, c)], g[idx(GRID_H - 1 - r, GRID_W - 1 - c)], `(${r},${c}) mirror`);
    }
  }
  assert.deepEqual(Array.from(buildGrid(42n)), Array.from(buildGrid(42n)));
});

import {
  BLAST_RADIUS,
  FUSE_TICKS,
  dest,
  canMoveTo,
  blastCellsFor,
  resolveExplosions,
  type BombItBomb,
  type BombItPlayer,
} from "./bombIt.ts";

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

const CTX = { tunnelId: "0xabc123", initialBalances: { a: BOMB_IT_MIN_STAKE, b: BOMB_IT_MIN_STAKE } };

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
  assert.equal(s.grid.length, 81);
});

test("encodeState is canonical and starts with the domain tag", () => {
  const p = new BombItProtocol();
  const a = p.initialState(CTX);
  const b = p.initialState(CTX);
  assert.deepEqual(Array.from(p.encodeState(a)), Array.from(p.encodeState(b)));
  const tag = new TextEncoder().encode("sui_tunnel::proto::bomb_it.v1");
  assert.deepEqual(Array.from(p.encodeState(a).slice(0, tag.length)), Array.from(tag));
});

test("encodeState differs when a player position differs", () => {
  const p = new BombItProtocol();
  const s = p.initialState(CTX);
  const moved = { ...s, players: [{ ...s.players[0], col: 2 }, s.players[1]] as typeof s.players };
  assert.notDeepEqual(Array.from(p.encodeState(s)), Array.from(p.encodeState(moved)));
});

test("balances return the stored split; isTerminal tracks winner", () => {
  const p = new BombItProtocol();
  const s = p.initialState(CTX);
  assert.deepEqual(p.balances(s), { a: BOMB_IT_MIN_STAKE, b: BOMB_IT_MIN_STAKE });
  assert.equal(p.isTerminal(s), false);
  assert.equal(p.isTerminal({ ...s, winner: "A" }), true);
  assert.equal(p.isTerminal({ ...s, winner: "draw" }), true);
});
