# Bomb It PvP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Bomb It — a minimal Bomberman-style grid duel — as a PvP-default arena game over one Sui tunnel, winner takes the pot.

**Architecture:** One new deterministic SDK protocol (`BombItProtocol`, `bomb_it.v1`) modelling the world one tick per dual-signed move, plus a frontend game package mirroring `frontend/src/games/chickenCross/` (PvP hook + lobby + board). Real-time play is bridged onto the half-duplex engine via alternate-proposer ping-pong (one seat acts per nonce; the world advances every propose; bomb fuses tick every advance). No backend or Move changes — both layers key off the game-id string.

**Tech Stack:** TypeScript; `sui-tunnel-ts` SDK (pnpm + `node:test` via `tsx`); React + Vite + Tailwind frontend; `@mysten/dapp-kit`; `DistributedTunnel` + `MpClient` PvP framework (all already on `feat/bomb-it-pvp`).

Spec: `docs/superpowers/specs/2026-06-19-bomb-it-pvp-design.md`.

## Global Constraints

- **Branch:** `feat/bomb-it-pvp` (already created off `feat/chicken-cross`; `main` lacks the PvP framework). Do NOT branch off `main` or `origin/feat/bomb-it`.
- **Toolchain (do not change):** `sui-tunnel-ts/` and `sui_tunnel/` are upstream-vendored — pnpm + `node:test` via `tsx`. Never convert to bun/biome. Frontend uses pnpm.
- **Two locations + two registration edits only:** `sui-tunnel-ts/src/protocol/bombIt.ts` (+ test) and `frontend/src/games/bombIt/`; edit `sui-tunnel-ts/src/protocol/index.ts` and `frontend/src/games/index.ts` to register. Backend (`tunnel-manager`), Move (`sui_tunnel`), `registry.ts`, `types.ts` stay UNCHANGED.
- **Protocol invariants:** `applyMove` pure (no input mutation) + throws on a terminal state; `balances(s).a + .b === total` for EVERY reachable state; `encodeState` canonical (same state → byte-identical) with all multi-byte ints 8-byte big-endian via `u64ToBeBytes`; state a pure function of `(seed-from-tunnelId, ordered moves)`.
- **Import discipline (tsx ignores the Vite alias at runtime):** `session-core.ts` → `import type … from "sui-tunnel-ts/…"` (type-only, React-free); `*.test.ts` runtime SDK imports → relative `.ts` paths; hooks/components/window (Vite-bundled) → bare specifier `from "sui-tunnel-ts/…"`.
- **Commits:** Conventional Commits, subject ≤ 50 chars, imperative, lowercase after type, no trailing period, **no AI attribution**. One logical change per commit.
- **Constants (verbatim):** `GRID_W=9 GRID_H=9 CELL_COUNT=81`; `CELL_FLOOR=0 CELL_WALL=1 CELL_CRATE=2`; `FUSE_TICKS=8 BLAST_RADIUS=2 MAX_BOMBS_PER_PLAYER=1 CRATE_DENSITY=0.75 BOMB_IT_TICK_CAP=400n BOMB_IT_MIN_STAKE=100n`; `SPAWN_A={row:1,col:1} SPAWN_B={row:7,col:7}`; hook `STAKE=500n STEP_MS=250`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `sui-tunnel-ts/src/protocol/bombIt.ts` | The protocol: constants, types, deterministic board, movement/blast helpers, `BombItProtocol` class. |
| `sui-tunnel-ts/src/protocol/bombIt.test.ts` | `tsx` unit tests for board, blast/chain, and the protocol class. |
| `sui-tunnel-ts/src/protocol/index.ts` | EDIT — re-export `bombIt`. |
| `frontend/src/games/bombIt/session-core.ts` | Pure `deriveView` + view types (type-only SDK import). |
| `frontend/src/games/bombIt/session-core.test.ts` | `tsx` unit test for `deriveView`/`sessionResult`. |
| `frontend/src/games/bombIt/usePvpBombIt.ts` | PvP hook: matchmaking, funding, engine, STEP_MS propose timer, scoped input, teardown, settlement. |
| `frontend/src/games/bombIt/components/BombLobby.tsx` | Create/join match-code screen. |
| `frontend/src/games/bombIt/components/BombBoard.tsx` | 9×9 grid render + keyboard/D-pad input. |
| `frontend/src/games/bombIt/bomb-it.css` | Grid/board styles. |
| `frontend/src/games/bombIt/BombItWindow.tsx` | Status router: lobby → board → result. |
| `frontend/src/games/bombIt/index.ts` | `register({ id: "bomb-it", … })`. |
| `frontend/src/games/index.ts` | EDIT — `import "./bombIt"` (side-effect registration). |

---

## Task 1: Board generation + layout helpers

**Files:**
- Create: `sui-tunnel-ts/src/protocol/bombIt.ts`
- Test: `sui-tunnel-ts/src/protocol/bombIt.test.ts`

**Interfaces:**
- Consumes: `protocolDomain`, `Party`, `Balances`, `ProtocolContext` from `./Protocol`; `concatBytes` from `../core/bytes`; `u64ToBeBytes` from `../core/wire`.
- Produces: constants (`GRID_W`, `GRID_H`, `CELL_COUNT`, `CELL_FLOOR`, `CELL_WALL`, `CELL_CRATE`, `FUSE_TICKS`, `BLAST_RADIUS`, `MAX_BOMBS_PER_PLAYER`, `CRATE_DENSITY`, `BOMB_IT_TICK_CAP`, `BOMB_IT_MIN_STAKE`, `SPAWN_A`, `SPAWN_B`); types (`BombItAction`, `BombItPlayer`, `BombItBomb`, `BombItState`, `BombItMove`); functions `idx(row,col)`, `isBorder(row,col)`, `isPillar(row,col)`, `inSpawnSafe(row,col)`, `buildGrid(seed: bigint): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Create `sui-tunnel-ts/src/protocol/bombIt.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/bombIt.test.ts`
Expected: FAIL — `Cannot find module './bombIt.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `sui-tunnel-ts/src/protocol/bombIt.ts`:

```ts
/**
 * Bomb It protocol: a TWO-PARTY Bomberman-style grid duel over a tunnel.
 *
 * A discrete, deterministic reformulation of a real-time bomber. Every world advance is
 * ONE tick = one dual-signed state update; the board, bomb fuses, blasts, and kills are a
 * pure function of (seed, ordered moves), so both parties — and an on-chain disputer
 * replaying encodeState — agree with no trusted server. Each tick one seat acts (move one
 * cell OR drop a bomb); the other implicitly stays. Both seats stake S; balances stay
 * (S, S) and flip to (2S, 0) / (0, 2S) only on the killing tick, so
 * balanceA + balanceB === total holds for every reachable state.
 */
import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
} from "./Protocol";
import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";

// ============================================
// CONFIG
// ============================================
export const GRID_W = 9;
export const GRID_H = 9;
export const CELL_COUNT = GRID_W * GRID_H; // 81

export const CELL_FLOOR = 0;
export const CELL_WALL = 1;
export const CELL_CRATE = 2;

export const FUSE_TICKS = 8;
export const BLAST_RADIUS = 2;
export const MAX_BOMBS_PER_PLAYER = 1;
export const CRATE_DENSITY = 0.75;
export const BOMB_IT_TICK_CAP = 400n;
/** Minimum fundable stake per seat (hook clamps to this). */
export const BOMB_IT_MIN_STAKE = 100n;

export const SPAWN_A = { row: 1, col: 1 };
export const SPAWN_B = { row: 7, col: 7 };

export type BombItAction = "north" | "south" | "east" | "west" | "bomb" | "stay";

export interface BombItPlayer {
  row: number;
  col: number;
  alive: boolean;
}
export interface BombItBomb {
  row: number;
  col: number;
  fuse: number;
  owner: Party;
}
export interface BombItState {
  tick: bigint;
  /** Board seed; derived from tunnelId; part of encodeState for exact replay. */
  seed: bigint;
  grid: Uint8Array; // length CELL_COUNT; 0 floor, 1 wall, 2 crate
  players: [BombItPlayer, BombItPlayer]; // index 0 = A, 1 = B
  bombs: BombItBomb[]; // <= 2 live (1 per seat)
  winner: Party | "draw" | null; // null = ongoing
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
}
/** One world tick: the acting seat fills its own field; the other is undefined = "stay". */
export interface BombItMove {
  a?: BombItAction;
  b?: BombItAction;
}

const DOMAIN = protocolDomain("bomb_it.v1");

// ============================================
// DETERMINISTIC HELPERS (pure)
// ============================================
/** Small, fast, fully deterministic PRNG (Mulberry32). */
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

/** Deterministic 32-bit seed from a tunnel object id string (FNV-1a). */
function seedFromTunnelId(tunnelId: string): bigint {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < tunnelId.length; i++) {
    h ^= tunnelId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return BigInt(h >>> 0);
}

export function idx(row: number, col: number): number {
  return row * GRID_W + col;
}
/** Outer ring is indestructible wall. */
export function isBorder(row: number, col: number): boolean {
  return row === 0 || row === GRID_H - 1 || col === 0 || col === GRID_W - 1;
}
/** Classic interior lattice pillar: both coordinates even. */
export function isPillar(row: number, col: number): boolean {
  return row % 2 === 0 && col % 2 === 0;
}
/** Spawn escape cells kept crate-free (A's, plus B's 180° mirror). */
export function inSpawnSafe(row: number, col: number): boolean {
  const a = (row === 1 && col === 1) || (row === 1 && col === 2) || (row === 2 && col === 1);
  const b = (row === 7 && col === 7) || (row === 7 && col === 6) || (row === 6 && col === 7);
  return a || b;
}

/**
 * Build the static board for a seed: walls + 180°-rotationally-symmetric crates, so the
 * layout is identical for both seats regardless of seed (fair, public, no commit-reveal).
 * Crate rolls are consumed only on canonical-half floor cells in row-major order, keeping
 * the sequence deterministic; the center (i === mirror) is a pillar and never rolled.
 */
export function buildGrid(seed: bigint): Uint8Array {
  const grid = new Uint8Array(CELL_COUNT);
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      if (isBorder(r, c) || isPillar(r, c)) grid[idx(r, c)] = CELL_WALL;
    }
  }
  const rng = mulberry32(Number(seed & 0xffffffffn));
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const i = idx(r, c);
      const mi = idx(GRID_H - 1 - r, GRID_W - 1 - c);
      if (i >= mi) continue; // canonical half only
      if (grid[i] !== CELL_FLOOR) continue;
      if (inSpawnSafe(r, c) || inSpawnSafe(GRID_H - 1 - r, GRID_W - 1 - c)) continue;
      if (rng() < CRATE_DENSITY) {
        grid[i] = CELL_CRATE;
        grid[mi] = CELL_CRATE;
      }
    }
  }
  return grid;
}
```

> Note: `seedFromTunnelId`, `Protocol`/`Party`/`Balances`/`ProtocolContext`/`DOMAIN`/`concatBytes`/`u64ToBeBytes` are imported/declared now but consumed by later tasks. `tsc` allows unused module-private bindings; if a lint step flags them, leave them — Task 3/4 use them.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/bombIt.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add sui-tunnel-ts/src/protocol/bombIt.ts sui-tunnel-ts/src/protocol/bombIt.test.ts
git commit -m "feat(sdk): bomb-it board + layout helpers"
```

---

## Task 2: Movement + blast helpers

**Files:**
- Modify: `sui-tunnel-ts/src/protocol/bombIt.ts`
- Test: `sui-tunnel-ts/src/protocol/bombIt.test.ts`

**Interfaces:**
- Consumes: Task 1's constants, `BombItPlayer`, `BombItBomb`, `idx`.
- Produces: `dest(row,col,action): [number,number]`; `canMoveTo(grid, bombs, other, nr, nc): boolean`; `blastCellsFor(grid, bomb): number[]`; `resolveExplosions(grid, bombs): { cells: Set<number>; remaining: BombItBomb[] }` (mutates `grid`: crate→floor).

- [ ] **Step 1: Write the failing test**

Append to `sui-tunnel-ts/src/protocol/bombIt.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/bombIt.test.ts`
Expected: FAIL — `dest is not exported` / `canMoveTo is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `sui-tunnel-ts/src/protocol/bombIt.ts` (after `buildGrid`):

```ts
// ============================================
// MOVEMENT + BLAST (pure)
// ============================================
export function dest(row: number, col: number, action: BombItAction): [number, number] {
  if (action === "north") return [row - 1, col];
  if (action === "south") return [row + 1, col];
  if (action === "east") return [row, col + 1];
  if (action === "west") return [row, col - 1];
  return [row, col]; // bomb / stay
}

/** A cell is enterable if it is on-board floor with no bomb and no living opponent. */
export function canMoveTo(
  grid: Uint8Array,
  bombs: BombItBomb[],
  other: BombItPlayer,
  nr: number,
  nc: number,
): boolean {
  if (nr < 0 || nr >= GRID_H || nc < 0 || nc >= GRID_W) return false;
  const cell = grid[idx(nr, nc)];
  if (cell === CELL_WALL || cell === CELL_CRATE) return false;
  if (bombs.some((b) => b.row === nr && b.col === nc)) return false;
  if (other.alive && other.row === nr && other.col === nc) return false;
  return true;
}

/** Cells one bomb's `+` blast covers: stops at walls; includes and stops at the first crate. */
export function blastCellsFor(grid: Uint8Array, bomb: BombItBomb): number[] {
  const out: number[] = [idx(bomb.row, bomb.col)];
  const dirs: Array<[number, number]> = [[-1, 0], [1, 0], [0, 1], [0, -1]];
  for (const [dr, dc] of dirs) {
    for (let step = 1; step <= BLAST_RADIUS; step++) {
      const r = bomb.row + dr * step;
      const c = bomb.col + dc * step;
      if (r < 0 || r >= GRID_H || c < 0 || c >= GRID_W) break;
      const cell = grid[idx(r, c)];
      if (cell === CELL_WALL) break;
      out.push(idx(r, c));
      if (cell === CELL_CRATE) break;
    }
  }
  return out;
}

/**
 * Detonate every fuse<=0 bomb, growing the set to a fixpoint (a bomb in any blast cell
 * detonates too), then destroy crated blast cells. Propagation reads the pre-blast grid so
 * crates stop the blast before being cleared. Mutates `grid`; returns the blast-cell union
 * and the surviving bombs.
 */
export function resolveExplosions(
  grid: Uint8Array,
  bombs: BombItBomb[],
): { cells: Set<number>; remaining: BombItBomb[] } {
  const detonating = new Set<number>();
  for (let i = 0; i < bombs.length; i++) if (bombs[i].fuse <= 0) detonating.add(i);

  const cells = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    cells.clear();
    for (const di of detonating) for (const ci of blastCellsFor(grid, bombs[di])) cells.add(ci);
    for (let i = 0; i < bombs.length; i++) {
      if (!detonating.has(i) && cells.has(idx(bombs[i].row, bombs[i].col))) {
        detonating.add(i);
        changed = true;
      }
    }
  }

  for (const ci of cells) if (grid[ci] === CELL_CRATE) grid[ci] = CELL_FLOOR;
  const remaining = bombs.filter((_, i) => !detonating.has(i));
  return { cells, remaining };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/bombIt.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add sui-tunnel-ts/src/protocol/bombIt.ts sui-tunnel-ts/src/protocol/bombIt.test.ts
git commit -m "feat(sdk): bomb-it movement + blast helpers"
```

---

## Task 3: BombItProtocol — state, encode, balances, terminal

**Files:**
- Modify: `sui-tunnel-ts/src/protocol/bombIt.ts`, `sui-tunnel-ts/src/protocol/index.ts`
- Test: `sui-tunnel-ts/src/protocol/bombIt.test.ts`

**Interfaces:**
- Consumes: Task 1/2 helpers, `DOMAIN`, `seedFromTunnelId`, `concatBytes`, `u64ToBeBytes`, `Protocol`/`Party`/`Balances`/`ProtocolContext`.
- Produces: `class BombItProtocol implements Protocol<BombItState, BombItMove>` with `name="bomb_it.v1"`, real `initialState`/`encodeState`/`balances`/`isTerminal` and stubbed `applyMove`/`randomMove` (filled in Task 4). `sui-tunnel-ts/src/protocol/index.ts` re-exports `bombIt`.

- [ ] **Step 1: Write the failing test**

Append to `sui-tunnel-ts/src/protocol/bombIt.test.ts`:

```ts
import { BombItProtocol, BOMB_IT_TICK_CAP } from "./bombIt.ts";

const CTX = { tunnelId: "0xabc123", initialBalances: { a: BOMB_IT_MIN_STAKE, b: BOMB_IT_MIN_STAKE } };
// BOMB_IT_MIN_STAKE is imported in the next line if not already:
import { BOMB_IT_MIN_STAKE } from "./bombIt.ts";

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
```

> If your runner rejects duplicate `import { BOMB_IT_MIN_STAKE }`, merge it into the Task 1 import block instead — `BOMB_IT_MIN_STAKE` must be imported exactly once.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/bombIt.test.ts`
Expected: FAIL — `BombItProtocol is not a constructor`.

- [ ] **Step 3: Write minimal implementation**

Append to `sui-tunnel-ts/src/protocol/bombIt.ts`:

```ts
// ============================================
// PROTOCOL
// ============================================
function spawn(row: number, col: number): BombItPlayer {
  return { row, col, alive: true };
}

export class BombItProtocol implements Protocol<BombItState, BombItMove> {
  readonly name = "bomb_it.v1";

  initialState(ctx: ProtocolContext): BombItState {
    const seed = seedFromTunnelId(ctx.tunnelId);
    return {
      tick: 0n,
      seed,
      grid: buildGrid(seed),
      players: [spawn(SPAWN_A.row, SPAWN_A.col), spawn(SPAWN_B.row, SPAWN_B.col)],
      bombs: [],
      winner: null,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
    };
  }

  applyMove(_state: BombItState, _move: BombItMove, _by: Party): BombItState {
    throw new Error("applyMove not implemented yet"); // Task 4
  }

  encodeState(s: BombItState): Uint8Array {
    const parts: Uint8Array[] = [
      DOMAIN,
      u64ToBeBytes(s.tick),
      u64ToBeBytes(s.seed),
      u64ToBeBytes(s.balanceA),
      u64ToBeBytes(s.balanceB),
      s.grid,
    ];
    for (const p of s.players) {
      parts.push(u64ToBeBytes(p.row), u64ToBeBytes(p.col), new Uint8Array([p.alive ? 1 : 0]));
    }
    // Two slots indexed by owner (slot 0 = A's live bomb or empty, slot 1 = B's).
    for (let slot = 0; slot < 2; slot++) {
      const owner: Party = slot === 0 ? "A" : "B";
      const b = s.bombs.find((x) => x.owner === owner);
      parts.push(
        new Uint8Array([b ? 1 : 0]),
        u64ToBeBytes(b ? b.row : 0),
        u64ToBeBytes(b ? b.col : 0),
        u64ToBeBytes(b ? b.fuse : 0),
        new Uint8Array([slot]),
      );
    }
    parts.push(
      new Uint8Array([s.winner === "A" ? 1 : s.winner === "B" ? 2 : s.winner === "draw" ? 3 : 0]),
    );
    return concatBytes(parts);
  }

  balances(s: BombItState): Balances {
    return { a: s.balanceA, b: s.balanceB };
  }

  isTerminal(s: BombItState): boolean {
    return s.winner !== null;
  }
}
```

- [ ] **Step 4: Run test + typecheck to verify they pass**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/bombIt.test.ts`
Expected: PASS (13 tests total).
Run: `cd sui-tunnel-ts && pnpm typecheck`
Expected: no errors (the stubbed `applyMove`/`randomMove` satisfy the interface; `randomMove` is optional so the stub may be omitted entirely — leaving it out is fine).

- [ ] **Step 5: Register the protocol**

Modify `sui-tunnel-ts/src/protocol/index.ts` — add the re-export after `./cross`:

```ts
export * from "./cross";
export * from "./bombIt";
```

- [ ] **Step 6: Commit**

```bash
git add sui-tunnel-ts/src/protocol/bombIt.ts sui-tunnel-ts/src/protocol/bombIt.test.ts sui-tunnel-ts/src/protocol/index.ts
git commit -m "feat(sdk): bomb-it protocol state + encoding"
```

---

## Task 4: BombItProtocol — applyMove + randomMove

**Files:**
- Modify: `sui-tunnel-ts/src/protocol/bombIt.ts`
- Test: `sui-tunnel-ts/src/protocol/bombIt.test.ts`

**Interfaces:**
- Consumes: all prior helpers + the `BombItProtocol` class.
- Produces: real `applyMove(state, move, by)` (one actor per call; world advance; terminal + balance flip; throws on terminal state or a move carrying the non-actor's field) and `randomMove(state, by, rng)` (fills only `by`'s field; legal action or `"stay"`). These are the contract later frontend tasks rely on via `dt.propose`.

- [ ] **Step 1: Write the failing test**

Append to `sui-tunnel-ts/src/protocol/bombIt.test.ts`:

```ts
import type { BombItMove, BombItState } from "./bombIt.ts";

/** Run the world forward applying the SAME move object both seats would (only one field set). */
function advance(p: BombItProtocol, s: BombItState, m: BombItMove): BombItState {
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

test("the tick cap forces a draw and conserves balances across a full playout", () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/bombIt.test.ts`
Expected: FAIL — `applyMove not implemented yet`.

- [ ] **Step 3: Write minimal implementation**

In `sui-tunnel-ts/src/protocol/bombIt.ts`, add the private `applyAction` helper before the class, and replace the stubbed `applyMove`; add `randomMove` after `isTerminal`:

```ts
/** Apply one seat's action in place: move (if enterable) or drop a bomb (if under cap). */
function applyAction(
  grid: Uint8Array,
  players: [BombItPlayer, BombItPlayer],
  bombs: BombItBomb[],
  i: number,
  action: BombItAction,
): void {
  const p = players[i];
  if (!p.alive || action === "stay") return;
  const owner: Party = i === 0 ? "A" : "B";
  if (action === "bomb") {
    const live = bombs.filter((b) => b.owner === owner).length;
    const here = bombs.some((b) => b.row === p.row && b.col === p.col);
    if (live < MAX_BOMBS_PER_PLAYER && !here) {
      bombs.push({ row: p.row, col: p.col, fuse: FUSE_TICKS, owner });
    }
    return;
  }
  const [nr, nc] = dest(p.row, p.col, action);
  if (canMoveTo(grid, bombs, players[i === 0 ? 1 : 0], nr, nc)) {
    p.row = nr;
    p.col = nc;
  }
}
```

Replace the `applyMove` stub body with:

```ts
  applyMove(state: BombItState, move: BombItMove, by: Party): BombItState {
    if (this.isTerminal(state)) {
      throw new Error("game over: bomb-it is already decided");
    }
    // Integrity: a seat may only carry its OWN action (hardens vs a forged opponent move).
    if (by === "A" && move.b !== undefined) throw new Error("A cannot submit B's action");
    if (by === "B" && move.a !== undefined) throw new Error("B cannot submit A's action");

    const grid = Uint8Array.from(state.grid);
    const players: [BombItPlayer, BombItPlayer] = [
      { ...state.players[0] },
      { ...state.players[1] },
    ];
    let bombs: BombItBomb[] = state.bombs.map((b) => ({ ...b }));

    applyAction(grid, players, bombs, 0, move.a ?? "stay");
    applyAction(grid, players, bombs, 1, move.b ?? "stay");

    for (const b of bombs) b.fuse -= 1;
    const { cells, remaining } = resolveExplosions(grid, bombs);
    bombs = remaining;
    for (const p of players) {
      if (p.alive && cells.has(idx(p.row, p.col))) p.alive = false;
    }

    const tick = state.tick + 1n;
    let winner: Party | "draw" | null = null;
    const aAlive = players[0].alive;
    const bAlive = players[1].alive;
    if (!aAlive && !bAlive) winner = "draw";
    else if (!bAlive) winner = "A";
    else if (!aAlive) winner = "B";
    else if (tick >= BOMB_IT_TICK_CAP) winner = "draw";

    let balanceA = state.balanceA;
    let balanceB = state.balanceB;
    if (winner === "A") {
      balanceA = state.total;
      balanceB = 0n;
    } else if (winner === "B") {
      balanceA = 0n;
      balanceB = state.total;
    }

    return { tick, seed: state.seed, grid, players, bombs, winner, balanceA, balanceB, total: state.total };
  }
```

Add `randomMove` after `isTerminal`:

```ts
  randomMove(s: BombItState, by: Party, rng: () => number): BombItMove | null {
    if (this.isTerminal(s)) return null;
    const i = by === "A" ? 0 : 1;
    const p = s.players[i];
    const field = (action: BombItAction): BombItMove => (by === "A" ? { a: action } : { b: action });
    if (!p.alive) return field("stay");
    const choices: BombItAction[] = ["stay"];
    for (const d of ["north", "south", "east", "west"] as BombItAction[]) {
      const [nr, nc] = dest(p.row, p.col, d);
      if (canMoveTo(s.grid, s.bombs, s.players[i === 0 ? 1 : 0], nr, nc)) choices.push(d);
    }
    const liveOwn = s.bombs.filter((b) => b.owner === by).length;
    const hereBomb = s.bombs.some((b) => b.row === p.row && b.col === p.col);
    if (liveOwn < MAX_BOMBS_PER_PLAYER && !hereBomb) choices.push("bomb");
    return field(choices[Math.floor(rng() * choices.length)]);
  }
```

- [ ] **Step 4: Run test + typecheck to verify they pass**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/bombIt.test.ts`
Expected: PASS (all tests; ~20 total).
Run: `cd sui-tunnel-ts && pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add sui-tunnel-ts/src/protocol/bombIt.ts sui-tunnel-ts/src/protocol/bombIt.test.ts
git commit -m "feat(sdk): bomb-it applyMove + random agent"
```

---

## Task 5: Frontend view-core (`deriveView`)

**Files:**
- Create: `frontend/src/games/bombIt/session-core.ts`
- Test: `frontend/src/games/bombIt/session-core.test.ts`

**Interfaces:**
- Consumes: `BombItState` (type-only) from `sui-tunnel-ts/protocol/bombIt`; in the test, `BombItProtocol`, `BOMB_IT_MIN_STAKE` via relative `.ts` path.
- Produces: `interface BombItView`; `type BombItResult = "A" | "B" | "draw"`; `deriveView(state): BombItView`; `sessionResult(state): BombItResult`. The board and hook consume `BombItView`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/bombIt/session-core.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
// Runtime SDK imports use RELATIVE .ts paths (tsx ignores the vite alias / tsconfig paths).
import { BombItProtocol, BOMB_IT_MIN_STAKE } from "../../../../sui-tunnel-ts/src/protocol/bombIt.ts";
import { deriveView, sessionResult } from "./session-core.ts";

const CTX = { tunnelId: "0xfeed", initialBalances: { a: BOMB_IT_MIN_STAKE, b: BOMB_IT_MIN_STAKE } };

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
  assert.equal(sessionResult({ ...s, winner: "draw" }), "draw");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --import tsx --test "src/games/bombIt/session-core.test.ts"`
Expected: FAIL — `Cannot find module './session-core.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/games/bombIt/session-core.ts`:

```ts
/**
 * Pure, React-free view driver for Bomb It. Only TYPE imports from the SDK so it runs under
 * tsx (the alias is not resolved at runtime). The hook owns keypairs, the timer, and the
 * on-chain open/close; BombBoard.tsx (Vite-bundled) owns rendering.
 */
import type { BombItState } from "sui-tunnel-ts/protocol/bombIt";

/** Flat, render-friendly snapshot of a BombItState (bigints -> numbers). */
export interface BombItView {
  tick: number;
  grid: number[]; // 81 cells: 0 floor, 1 wall, 2 crate
  players: { row: number; col: number; alive: boolean }[];
  bombs: { row: number; col: number; fuse: number; owner: "A" | "B" }[];
  winner: "A" | "B" | "draw" | null;
  balanceA: number;
  balanceB: number;
}

/** Who took the pot (or a push). */
export type BombItResult = "A" | "B" | "draw";

export function deriveView(state: BombItState): BombItView {
  return {
    tick: Number(state.tick),
    grid: Array.from(state.grid),
    players: state.players.map((p) => ({ row: p.row, col: p.col, alive: p.alive })),
    bombs: state.bombs.map((b) => ({ row: b.row, col: b.col, fuse: b.fuse, owner: b.owner })),
    winner: state.winner,
    balanceA: Number(state.balanceA),
    balanceB: Number(state.balanceB),
  };
}

export function sessionResult(state: BombItState): BombItResult {
  if (state.winner === "A") return "A";
  if (state.winner === "B") return "B";
  return "draw";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node --import tsx --test "src/games/bombIt/session-core.test.ts"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/bombIt/session-core.ts frontend/src/games/bombIt/session-core.test.ts
git commit -m "feat(web): bomb-it view-core"
```

---

## Task 6: PvP hook (`usePvpBombIt`)

**Files:**
- Create: `frontend/src/games/bombIt/usePvpBombIt.ts`

**Interfaces:**
- Consumes: SDK + framework via bare specifiers (mirrors `usePvpChickenCross`): `generateKeyPair`/`KeyPair` (`sui-tunnel-ts/core/crypto`), `defaultBackend` (`…/core/crypto-native`), `makeEndpoint` (`…/core/tunnel`), `fromHex`/`toHex` (`…/core/bytes`), `DistributedTunnel` (`…/core/distributedTunnel`), `BombItProtocol`/`BombItState`/`BombItMove`/`BombItAction` (`…/protocol/bombIt`), `MpClient`/`resolveMpWsUrl`/`PvpChannel`/`Role` (`../../pvp/mpClient`), `resolveBackendUrl` (`../../backend/controlPlane`), `closeCooperative`/`depositStake`/`openAndFundSharedTunnel`/`readCreatedAt` (`../../onchain/tunnelTx`), `deriveView`/`BombItView` (`./session-core`).
- Produces: `usePvpBombIt(): PvpBombIt` where `PvpBombIt = { status: PvpStatus; role: Role | null; view: BombItView | null; winner: "A"|"B"|"draw"|null; error: string | null; create(code): void; join(code): void; queueAction(a: BombItAction): void; reset(): void }`. The Window (Task 8) consumes this.

> This hook is a structural mirror of `frontend/src/games/chickenCross/usePvpChickenCross.ts` (read it for the full lifecycle commentary). The substantive differences: `BombIt*` types; `STEP_MS=250`; the input ref holds a `BombItAction` defaulting to `"stay"` (NOT auto-forward "north") and resets to `"stay"` after each propose; the lobby key is `"bomb-it:"`; `winner` includes `"draw"`; the public input method is `queueAction` (not `setDir`).

- [ ] **Step 1: Write the implementation**

Create `frontend/src/games/bombIt/usePvpBombIt.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { BombItProtocol, type BombItState, type BombItMove, type BombItAction } from "sui-tunnel-ts/protocol/bombIt";
import { MpClient, resolveMpWsUrl, type PvpChannel, type Role } from "../../pvp/mpClient";
import { resolveBackendUrl } from "../../backend/controlPlane";
import { closeCooperative, depositStake, openAndFundSharedTunnel, readCreatedAt } from "../../onchain/tunnelTx";
import { deriveView, type BombItView } from "./session-core";

const STAKE = 500n; // per-seat MIST
const STEP_MS = 250; // pacing between ticks (ms)

export type PvpStatus = "idle" | "matching" | "funding" | "playing" | "settling" | "settled" | "error";

export interface PvpBombIt {
  status: PvpStatus;
  role: Role | null;
  view: BombItView | null;
  winner: "A" | "B" | "draw" | null;
  error: string | null;
  create: (code: string) => void;
  join: (code: string) => void;
  queueAction: (a: BombItAction) => void;
  reset: () => void;
}

/** Buffer peer messages so a waiter never misses one that arrived early. */
function makeInbox(channel: PvpChannel) {
  const buf = new Map<string, unknown>();
  const waiters = new Map<string, (m: unknown) => void>();
  channel.onPeer((m) => {
    const w = waiters.get(m.t);
    if (w) {
      waiters.delete(m.t);
      w(m);
    } else {
      buf.set(m.t, m);
    }
  });
  return <T = unknown>(t: string): Promise<T> =>
    new Promise((res) => {
      const b = buf.get(t);
      if (b) {
        buf.delete(t);
        res(b as T);
      } else {
        waiters.set(t, res as (m: unknown) => void);
      }
    });
}

/** Which seat proposes at this nonce: A proposes nonce 0→1, B 1→2, A 2→3, … */
function turn(nonce: bigint): Role {
  return nonce % 2n === 0n ? "A" : "B";
}

export function usePvpBombIt(): PvpBombIt {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [status, setStatus] = useState<PvpStatus>("idle");
  const [role, setRole] = useState<Role | null>(null);
  const [view, setView] = useState<BombItView | null>(null);
  const [winner, setWinner] = useState<"A" | "B" | "draw" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mpRef = useRef<MpClient | null>(null);
  const dtRef = useRef<DistributedTunnel<BombItState, BombItMove> | null>(null);
  const roleRef = useRef<Role | null>(null);
  const nextActionRef = useRef<BombItAction>("stay");
  const proposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settlingRef = useRef(false);

  /** Schedule a propose for this seat if it's our turn. Clears any existing timer first. */
  const maybePropose = useCallback(() => {
    const dt = dtRef.current;
    const myRole = roleRef.current;
    if (!dt || !myRole) return;
    if (dt.protocol.isTerminal(dt.state)) return;
    if (turn(dt.nonce) !== myRole) return;

    if (proposeTimerRef.current !== null) {
      clearTimeout(proposeTimerRef.current);
      proposeTimerRef.current = null;
    }

    proposeTimerRef.current = setTimeout(() => {
      proposeTimerRef.current = null;
      const dtNow = dtRef.current;
      const myRoleNow = roleRef.current;
      if (!dtNow || !myRoleNow) return;
      if (dtNow.protocol.isTerminal(dtNow.state)) return;
      if (turn(dtNow.nonce) !== myRoleNow) return;

      const action = nextActionRef.current;
      nextActionRef.current = "stay"; // consume; idle default is stay
      const move: BombItMove = myRoleNow === "A" ? { a: action } : { b: action };
      try {
        dtNow.propose(move, 0n);
      } catch {
        // Proposal already pending or other transient error — safe to ignore here.
      }
    }, STEP_MS);
  }, []);

  const reset = useCallback(() => {
    if (proposeTimerRef.current !== null) {
      clearTimeout(proposeTimerRef.current);
      proposeTimerRef.current = null;
    }
    mpRef.current?.close();
    mpRef.current = null;
    dtRef.current = null;
    roleRef.current = null;
    nextActionRef.current = "stay";
    settlingRef.current = false;
    setStatus("idle");
    setRole(null);
    setView(null);
    setWinner(null);
    setError(null);
  }, []);

  // Cleanup on unmount — tear down timer, relay connection, and engine.
  useEffect(() => {
    return () => {
      if (proposeTimerRef.current !== null) {
        clearTimeout(proposeTimerRef.current);
        proposeTimerRef.current = null;
      }
      mpRef.current?.close();
      mpRef.current = null;
      dtRef.current = null;
    };
  }, []);

  /** Shared matchmaking + lifecycle for both create and join. */
  const startMatch = useCallback(
    (code: string) => {
      if (!account) {
        setError("connect a wallet first");
        return;
      }
      const wallet = account.address;
      const signExec = async (tx: Parameters<typeof signAndExecute>[0]["transaction"]) => {
        const r = await signAndExecute({ transaction: tx });
        return { digest: r.digest };
      };
      const reads = client as unknown as Parameters<typeof openAndFundSharedTunnel>[0]["reads"];

      (async () => {
        try {
          setError(null);
          setStatus("matching");
          const ephemeral: KeyPair = generateKeyPair();
          const mp = new MpClient(resolveMpWsUrl(resolveBackendUrl()), wallet, ephemeral);
          mpRef.current = mp;
          await mp.connect();

          const gameKey = "bomb-it:" + code.trim().toUpperCase();
          const match = await mp.quickMatch(gameKey);
          roleRef.current = match.role;
          setRole(match.role);

          const channel = mp.channel(match.matchId);
          const waitPeer = makeInbox(channel);

          // 1) exchange ephemeral pubkeys
          channel.sendPeer({ t: "hello", ephemeralPubkey: toHex(ephemeral.publicKey) });
          const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
          const oppPub = fromHex(hello.ephemeralPubkey);

          // 2) fund on-chain
          setStatus("funding");
          let tunnelId: string;
          if (match.role === "A") {
            tunnelId = await openAndFundSharedTunnel({
              reads,
              signExec,
              partyA: { address: wallet, publicKey: ephemeral.publicKey },
              partyB: { address: match.opponentWallet, publicKey: oppPub },
              amount: STAKE,
            });
            mp.announceTunnel(match.matchId, tunnelId);
            channel.sendPeer({ t: "open", tunnelId });
          } else {
            const open = await waitPeer<{ tunnelId: string }>("open");
            tunnelId = open.tunnelId;
            await depositStake({ signExec, tunnelId, amount: STAKE });
          }

          // 3) build the distributed engine
          const proto = new BombItProtocol();
          const backend = defaultBackend();
          const self = makeEndpoint(backend, wallet, ephemeral, true);
          const opp = makeEndpoint(
            backend,
            match.opponentWallet,
            { publicKey: oppPub, scheme: ephemeral.scheme },
            false,
          );
          const dt = new DistributedTunnel<BombItState, BombItMove>(
            proto,
            { tunnelId, self, opponent: opp, selfParty: match.role },
            channel.transport,
            { a: STAKE, b: STAKE },
          );
          dtRef.current = dt;

          dt.onConfirmed = () => {
            setView(deriveView(dt.displayState));
            const currentWinner = dt.state.winner;
            if (currentWinner !== null) setWinner(currentWinner);

            if (proto.isTerminal(dt.state) && !settlingRef.current) {
              settlingRef.current = true;
              void settle(dt, match.role, channel, waitPeer, reads, signExec, tunnelId).then(
                () => setStatus("settled"),
                (e) => {
                  setError(String((e as Error)?.message ?? e));
                  setStatus("error");
                },
              );
              setStatus("settling");
            } else {
              maybePropose();
            }
          };

          // 4) readiness handshake — after engine is live
          setView(deriveView(dt.displayState));
          setStatus("playing");
          if (match.role === "A") await waitPeer("ready");
          else channel.sendPeer({ t: "ready" });

          // Kick off seat A's first move (nonce 0 → A's turn)
          maybePropose();
        } catch (e) {
          setError(String((e as Error)?.message ?? e));
          setStatus("error");
        }
      })();
    },
    [account, client, signAndExecute, maybePropose],
  );

  const create = useCallback((code: string) => startMatch(code), [startMatch]);
  const join = useCallback((code: string) => startMatch(code), [startMatch]);
  const queueAction = useCallback((a: BombItAction) => {
    nextActionRef.current = a;
  }, []);

  return { status, role, view, winner, error, create, join, queueAction, reset };
}

/** Exchange settlement halves over the relay; seat A submits the cooperative close. */
async function settle(
  dt: DistributedTunnel<BombItState, BombItMove>,
  role: Role,
  channel: PvpChannel,
  waitPeer: <T>(t: string) => Promise<T>,
  reads: Parameters<typeof readCreatedAt>[0],
  signExec: Parameters<typeof closeCooperative>[0]["signExec"],
  tunnelId: string,
): Promise<void> {
  const createdAt = await readCreatedAt(reads, tunnelId);
  const half = dt.buildSettlementHalf(createdAt, 0n);
  channel.sendPeer({
    t: "settleHalf",
    partyABalance: half.settlement.partyABalance.toString(),
    partyBBalance: half.settlement.partyBBalance.toString(),
    finalNonce: half.settlement.finalNonce.toString(),
    timestamp: half.settlement.timestamp.toString(),
    sig: toHex(half.sigSelf),
  });
  const other = await waitPeer<{ sig: string }>("settleHalf");
  const co = dt.combineSettlement(half.settlement, half.sigSelf, fromHex(other.sig));
  if (role === "A") {
    await closeCooperative({ signExec, tunnelId, settlement: co });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: no errors. (If `dt.protocol` or any member is flagged, re-confirm signatures against `usePvpChickenCross.ts` — they share the exact engine API.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/bombIt/usePvpBombIt.ts
git commit -m "feat(web): bomb-it pvp hook"
```

---

## Task 7: Lobby + board + styles

**Files:**
- Create: `frontend/src/games/bombIt/components/BombLobby.tsx`
- Create: `frontend/src/games/bombIt/components/BombBoard.tsx`
- Create: `frontend/src/games/bombIt/bomb-it.css`

**Interfaces:**
- Consumes: `BombItView` (`../session-core`); `GRID_W`/`GRID_H`/`CELL_WALL`/`CELL_CRATE`/`BombItAction` (`sui-tunnel-ts/protocol/bombIt`, bare specifier — these are Vite-bundled components).
- Produces: `BombLobby({ onCreate, onJoin })`; `BombBoard({ view, winner, role, onAction, onPlayAgain })`. Consumed by the Window (Task 8). `onAction` is wired to the hook's `queueAction`.

- [ ] **Step 1: Write the styles**

Create `frontend/src/games/bombIt/bomb-it.css`:

```css
.bomb-grid {
  display: grid;
  gap: 1px;
  background: rgba(255, 255, 255, 0.05);
  aspect-ratio: 1 / 1;
  max-height: 100%;
  margin: 0 auto;
}
.bomb-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  line-height: 1;
  transition: background 100ms linear;
}
```

- [ ] **Step 2: Write the lobby**

Create `frontend/src/games/bombIt/components/BombLobby.tsx`:

```tsx
import { useState } from "react";
import "../bomb-it.css";

function randomCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export function BombLobby({
  onCreate,
  onJoin,
}: {
  onCreate: (code: string) => void;
  onJoin: (code: string) => void;
}) {
  const [input, setInput] = useState("");
  const [activeCode, setActiveCode] = useState<string | null>(null);

  const handleCreate = () => {
    const code = input.trim().toUpperCase() || randomCode();
    setActiveCode(code);
    setInput(code);
    onCreate(code);
  };

  const handleJoin = () => {
    const code = input.trim().toUpperCase();
    if (!code) return;
    onJoin(code);
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-arena-bg p-4 text-center">
      <h2 className="text-gold text-lg font-extrabold uppercase tracking-widest">Bomb It PvP</h2>
      <p className="max-w-xs text-sm text-arena-muted">
        Create a match, share the code; opponent joins with it (2nd tab works).
      </p>

      {activeCode && (
        <div className="flex flex-col items-center gap-1 rounded border border-amber-500 bg-arena-accent/10 px-6 py-3">
          <span className="text-[11px] uppercase tracking-wider text-arena-muted">Your match code</span>
          <span className="font-mono text-2xl font-extrabold tracking-[0.25em] text-gold">{activeCode}</span>
          <span className="text-[11px] text-arena-muted">Share this with your opponent</span>
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-arena-muted">Match Code</span>
        <input
          type="text"
          maxLength={8}
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase())}
          placeholder="e.g. AB12"
          className="w-40 rounded border border-arena-edge bg-arena-bg px-2 py-1.5 text-center font-mono uppercase text-arena-text placeholder:text-arena-muted/50"
        />
      </label>

      <div className="flex gap-3">
        <button
          onClick={handleCreate}
          className="gold-glow-hover rounded border border-amber-500 bg-arena-accent px-5 py-2 font-bold uppercase tracking-widest text-arena-bg transition-all hover:opacity-90"
        >
          Create Match
        </button>
        <button
          onClick={handleJoin}
          disabled={!input.trim()}
          className="rounded border border-arena-edge px-5 py-2 font-bold uppercase tracking-widest text-arena-text transition-all hover:opacity-90 disabled:opacity-40"
        >
          Join Match
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the board**

Create `frontend/src/games/bombIt/components/BombBoard.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { GRID_W, GRID_H, CELL_WALL, CELL_CRATE } from "sui-tunnel-ts/protocol/bombIt";
import type { BombItAction } from "sui-tunnel-ts/protocol/bombIt";
import "../bomb-it.css";
import type { BombItView } from "../session-core";

export function BombBoard({
  view,
  winner,
  role,
  onAction,
  onPlayAgain,
}: {
  view: BombItView;
  winner: "A" | "B" | "draw" | null;
  role: "A" | "B" | null;
  onAction: (a: BombItAction) => void;
  onPlayAgain: () => void;
}) {
  const settled = winner !== null;
  const boardRef = useRef<HTMLDivElement>(null);

  // Focus the board container on mount so keyboard events are scoped to it.
  useEffect(() => {
    boardRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (settled) return;
    switch (e.key) {
      case "ArrowUp":
      case "w":
      case "W":
        e.preventDefault();
        onAction("north");
        break;
      case "ArrowDown":
      case "s":
      case "S":
        e.preventDefault();
        onAction("south");
        break;
      case "ArrowRight":
      case "d":
      case "D":
        e.preventDefault();
        onAction("east");
        break;
      case "ArrowLeft":
      case "a":
      case "A":
        e.preventDefault();
        onAction("west");
        break;
      case " ":
      case "Spacebar":
        e.preventDefault();
        onAction("bomb");
        break;
    }
  };

  const bombAt = (r: number, c: number) => view.bombs.some((b) => b.row === r && b.col === c);
  const playerAt = (r: number, c: number): "A" | "B" | null => {
    if (view.players[0]?.alive && view.players[0].row === r && view.players[0].col === c) return "A";
    if (view.players[1]?.alive && view.players[1].row === r && view.players[1].col === c) return "B";
    return null;
  };

  return (
    <div
      ref={boardRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex h-full w-full flex-col gap-2 bg-arena-bg p-3 outline-none"
    >
      <div className="flex items-center justify-between text-[11px] text-arena-muted">
        <span>
          {role === "A" ? <span className="font-bold text-gold">🤖 A (you)</span> : <span>🤖 A</span>} · $
          {view.balanceA}
          {view.players[0]?.alive ? "" : " 💀"}
        </span>
        <span>tick {view.tick}</span>
        <span>
          {role === "B" ? <span className="font-bold text-gold">👾 B (you)</span> : <span>👾 B</span>} · $
          {view.balanceB}
          {view.players[1]?.alive ? "" : " 💀"}
        </span>
      </div>

      <div
        className="bomb-grid flex-1 overflow-hidden rounded border border-arena-edge"
        style={{
          gridTemplateColumns: `repeat(${GRID_W}, 1fr)`,
          gridTemplateRows: `repeat(${GRID_H}, 1fr)`,
        }}
      >
        {Array.from({ length: GRID_H }).map((_, r) =>
          Array.from({ length: GRID_W }).map((_, c) => {
            const cell = view.grid[r * GRID_W + c];
            const who = playerAt(r, c);
            const mine = who !== null && who === role;
            let glyph = "";
            if (who === "A") glyph = "🤖";
            else if (who === "B") glyph = "👾";
            else if (bombAt(r, c)) glyph = "💣";
            else if (cell === CELL_CRATE) glyph = "📦";
            const bg = cell === CELL_WALL ? "#3a3a3a" : "#15171c";
            return (
              <div
                key={`${r}-${c}`}
                className={`bomb-cell${mine ? " outline outline-2 outline-amber-400" : ""}`}
                style={{ background: bg }}
              >
                {glyph}
              </div>
            );
          }),
        )}
      </div>

      {!settled && (
        <div className="flex flex-col items-center gap-1 py-1">
          <button
            onPointerDown={() => onAction("north")}
            className="rounded border border-arena-edge px-4 py-1 text-xs text-arena-text hover:opacity-80 active:scale-95"
            aria-label="Move north"
          >
            ▲
          </button>
          <div className="flex gap-2">
            <button
              onPointerDown={() => onAction("west")}
              className="rounded border border-arena-edge px-4 py-1 text-xs text-arena-text hover:opacity-80 active:scale-95"
              aria-label="Move west"
            >
              ◀
            </button>
            <button
              onPointerDown={() => onAction("bomb")}
              className="rounded border border-amber-500 bg-arena-accent px-4 py-1 text-xs font-bold text-arena-bg hover:opacity-90 active:scale-95"
              aria-label="Drop bomb"
            >
              💣
            </button>
            <button
              onPointerDown={() => onAction("east")}
              className="rounded border border-arena-edge px-4 py-1 text-xs text-arena-text hover:opacity-80 active:scale-95"
              aria-label="Move east"
            >
              ▶
            </button>
          </div>
          <button
            onPointerDown={() => onAction("south")}
            className="rounded border border-arena-edge px-4 py-1 text-xs text-arena-text hover:opacity-80 active:scale-95"
            aria-label="Move south"
          >
            ▼
          </button>
        </div>
      )}

      {settled && (
        <div className="flex flex-col items-center gap-2 py-1">
          <p className="text-gold text-sm font-bold uppercase tracking-widest">
            {winner === "draw" ? "Draw — stakes returned" : winner === role ? "You win the pot!" : "Opponent wins"}
          </p>
          <button
            onClick={onPlayAgain}
            className="rounded border border-arena-edge px-3 py-1.5 text-sm text-arena-text hover:opacity-90"
          >
            Play Again
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/bombIt/components/BombLobby.tsx frontend/src/games/bombIt/components/BombBoard.tsx frontend/src/games/bombIt/bomb-it.css
git commit -m "feat(web): bomb-it lobby + board"
```

---

## Task 8: Window + registration + gate

**Files:**
- Create: `frontend/src/games/bombIt/BombItWindow.tsx`
- Create: `frontend/src/games/bombIt/index.ts`
- Modify: `frontend/src/games/index.ts`

**Interfaces:**
- Consumes: `GameWindowProps` (`../types`); `usePvpBombIt` (`./usePvpBombIt`); `BombLobby`/`BombBoard` (`./components/…`); `register` (`../registry`).
- Produces: `BombItWindow` component; the registered game module `{ id: "bomb-it", name: "Bomb It", icon: "💣", Window: BombItWindow }`; the side-effect import in `frontend/src/games/index.ts`.

- [ ] **Step 1: Write the window**

Create `frontend/src/games/bombIt/BombItWindow.tsx`:

```tsx
import type { GameWindowProps } from "../types";
import { usePvpBombIt } from "./usePvpBombIt";
import { BombLobby } from "./components/BombLobby";
import { BombBoard } from "./components/BombBoard";

/** PvP Bomb It: two players bomb each other on a shared grid over a Sui tunnel. */
export function BombItWindow(_props: GameWindowProps) {
  const { status, role, view, winner, error, create, join, queueAction, reset } = usePvpBombIt();

  if (status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-red-400">{error ?? "something went wrong"}</p>
        <button onClick={reset} className="rounded border border-arena-edge px-3 py-1.5 text-sm">
          Back
        </button>
      </div>
    );
  }

  if (status === "idle") {
    return <BombLobby onCreate={create} onJoin={join} />;
  }

  if (status === "matching") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-arena-muted">
        Waiting for opponent… share your code.
      </div>
    );
  }

  if (status === "funding") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-arena-muted">
        Opening + funding the tunnel on-chain… approve in your wallet.
      </div>
    );
  }

  if ((status === "playing" || status === "settling" || status === "settled") && view !== null) {
    return (
      <BombBoard view={view} winner={winner} role={role} onAction={queueAction} onPlayAgain={reset} />
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-arena-muted">
      Loading…
    </div>
  );
}
```

- [ ] **Step 2: Write the registration**

Create `frontend/src/games/bombIt/index.ts`:

```ts
import { register } from "../registry";
import { BombItWindow } from "./BombItWindow";

register({
  id: "bomb-it",
  name: "Bomb It",
  icon: "💣",
  Window: BombItWindow,
});
```

- [ ] **Step 3: Wire the side-effect import**

Modify `frontend/src/games/index.ts` — add the import after `./chickenCross`:

```ts
import "./blackjack";
import "./chickenCross";
import "./bombIt";
import "./quantumPoker";
import "./ticTacToe";
import "./chat";
import "./regularPayments";
import "./coinFlip";
import "./dice";
import "./slots";
```

- [ ] **Step 4: Run the full gate**

Run: `cd sui-tunnel-ts && node --import tsx --test --test-isolation=none "src/protocol/bombIt.test.ts"`
Expected: PASS (all protocol tests).

Run: `cd frontend && node --import tsx --test "src/games/bombIt/session-core.test.ts"`
Expected: PASS.

Run: `cd frontend && pnpm build`
Expected: `tsc --noEmit` clean, then `vite build` succeeds. This also proves single registration — a duplicate `id` would throw `duplicate game module id: bomb-it`. If the build reports a duplicate, the game is imported twice in `index.ts`; remove the extra line.

> **Manual e2e (cannot run headless — note in the PR, do not block the gate on it):** start the backend `tunnel-manager` `/v1/mp` relay; `cd frontend && pnpm dev`; open two tabs with two testnet wallet accounts (`sui_tunnel` deployed at `VITE_TUNNEL_PACKAGE_ID`); one Creates a code, the other Joins; verify both fund, the duel plays, a bomb kill ends the match, and the winner is paid (or a draw returns stakes).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/bombIt/BombItWindow.tsx frontend/src/games/bombIt/index.ts frontend/src/games/index.ts
git commit -m "feat(web): register bomb-it in the arena"
```

---

## Self-Review (completed during plan authoring)

**Spec coverage:**
- Spec §2 protocol (state/move/encodeState/board/mechanics/win/balances) → Tasks 1–4.
- Spec §2 180° symmetry + tunnelId seed → Task 1 (`buildGrid` test).
- Spec §2 blast/chain/crate-stop → Task 2; soft-invalid no-op + throw-on-terminal/non-actor → Task 4.
- Spec §3 engine constraints + §4 ping-pong + §6 lifecycle → Task 6 hook (`turn`, `maybePropose`, `settle`).
- Spec §4 default action `"stay"` (no auto-forward) → Task 6 (`nextActionRef="stay"`, reset after propose).
- Spec §5 code-based lobby (`"bomb-it:"`) → Tasks 6 + 7.
- Spec §7 files → all tasks; registration → Tasks 3 + 8.
- Spec §8 gate (tsx tests + typecheck/build + manual e2e) → Task 8.

**Placeholder scan:** none — every step has complete code or an exact command + expected output.

**Type consistency:** `BombItView`, `BombItAction`, `BombItState`, `BombItMove`, `deriveView`, `sessionResult`, `queueAction`, `onAction`, `PvpBombIt` used identically across Tasks 5–8. Engine member names (`dt.protocol`, `dt.state`, `dt.displayState`, `dt.nonce`, `dt.onConfirmed`, `dt.propose`, `dt.buildSettlementHalf`, `dt.combineSettlement`) match `usePvpChickenCross.ts` verbatim.
