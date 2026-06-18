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
 * Detonate every fuse<=0 bomb, growing the set to a fixpoint (a bomb inside any blast cell
 * detonates too), then destroy crated blast cells. Propagation reads the pre-blast grid so
 * crates STOP the blast (a bomb shielded behind a crate does not chain) before any crate is
 * cleared. Mutates `grid` (crate→floor); returns the blast-cell union and surviving bombs.
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
