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
export const TICK_CAP = 400n;
/** Minimum fundable stake per seat (hook clamps to this). */
export const MIN_STAKE = 100n;

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
