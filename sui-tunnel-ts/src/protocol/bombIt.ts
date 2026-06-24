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
 *
 * PvP fairness: the seed derives deterministically from the Sui-assigned tunnelId, not a
 * commit-reveal. Safe because the grid is PUBLIC and 180°-rotationally symmetric — both seats
 * face the same layout, the tunnelId cannot be ground, and there is no hidden state to bias.
 * Commit-reveal is reserved for hidden-information games (see docs/decisions/0010).
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
// 21×21 ≈ half the 29×29 cell count — still odd so spawn corners stay on floor tiles.
export const GRID_W = 21;
export const GRID_H = 21;
export const CELL_COUNT = GRID_W * GRID_H; // 441

export const CELL_FLOOR = 0;
export const CELL_WALL = 1;
export const CELL_CRATE = 2;

export const FUSE_TICKS = 8;
export const BLAST_RADIUS = 2;
export const MAX_BOMBS_PER_PLAYER = 1;
/** Sparser crates than the small board so the big arena stays traversable (bots roam/survive). */
export const CRATE_DENSITY = 0.35;
/** Fixed match budget: ~30s at the batched self-play rate (~180 ticks/s); the cap forces a
 *  decisive end (a kill, else a draw) so a solo match runs long and steady, not 5 seconds. */
export const BOMB_IT_TICK_CAP = 5400n;
/** Minimum fundable stake per seat (hook clamps to this). */
export const BOMB_IT_MIN_STAKE = 100n;

export const SPAWN_A = { row: 1, col: 1 };
/** 180°-mirror corner of SPAWN_A; odd,odd ⇒ floor (not a pillar). */
export const SPAWN_B = { row: GRID_H - 2, col: GRID_W - 2 };

export type BombItAction =
  | "north"
  | "south"
  | "east"
  | "west"
  | "bomb"
  | "stay";

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
/** Spawn escape cells kept crate-free (A's L, plus B's 180° mirror), relative to the grid. */
export function inSpawnSafe(row: number, col: number): boolean {
  const br = GRID_H - 2;
  const bc = GRID_W - 2;
  const a =
    (row === 1 && col === 1) ||
    (row === 1 && col === 2) ||
    (row === 2 && col === 1);
  const b =
    (row === br && col === bc) ||
    (row === br && col === bc - 1) ||
    (row === br - 1 && col === bc);
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
      if (inSpawnSafe(r, c) || inSpawnSafe(GRID_H - 1 - r, GRID_W - 1 - c))
        continue;
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
export function dest(
  row: number,
  col: number,
  action: BombItAction,
): [number, number] {
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
  const dirs: Array<[number, number]> = [
    [-1, 0],
    [1, 0],
    [0, 1],
    [0, -1],
  ];
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
  for (let i = 0; i < bombs.length; i++)
    if (bombs[i].fuse <= 0) detonating.add(i);

  const cells = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    cells.clear();
    for (const di of detonating)
      for (const ci of blastCellsFor(grid, bombs[di])) cells.add(ci);
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

function spawn(row: number, col: number): BombItPlayer {
  return { row, col, alive: true };
}

/** Cells any live bomb will cover when it detonates — a conservative danger map the bots avoid. */
function dangerCells(grid: Uint8Array, bombs: BombItBomb[]): Set<number> {
  const d = new Set<number>();
  for (const b of bombs) for (const ci of blastCellsFor(grid, b)) d.add(ci);
  return d;
}

/** One step outside an imminent blast — bots treat these as unsafe when a safer route exists. */
function adjacentDanger(danger: Set<number>): Set<number> {
  const adj = new Set<number>();
  const dirs: BombItAction[] = ["north", "south", "east", "west"];
  for (const ci of danger) {
    const row = Math.floor(ci / GRID_W);
    const col = ci % GRID_W;
    for (const d of dirs) {
      const [nr, nc] = dest(row, col, d);
      if (nr >= 0 && nr < GRID_H && nc >= 0 && nc < GRID_W) adj.add(idx(nr, nc));
    }
  }
  return adj;
}

function manhattan(a: { row: number; col: number }, b: { row: number; col: number }): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

/**
 * Survival-first self-play policy: dodge live blasts, rarely plant bombs, and only bomb when
 * an opponent is clearly in line or a crate fully blocks pursuit — with a verified escape.
 */
function hunterAction(
  s: BombItState,
  by: Party,
  rng: () => number,
): BombItAction {
  const i = by === "A" ? 0 : 1;
  const p = s.players[i];
  const other = s.players[i === 0 ? 1 : 0];
  if (!p.alive) return "stay";

  const danger = dangerCells(s.grid, s.bombs);
  const near = adjacentDanger(danger);
  const dirs: BombItAction[] = ["north", "south", "east", "west"];
  const moves = dirs.filter((d) => {
    const [nr, nc] = dest(p.row, p.col, d);
    return canMoveTo(s.grid, s.bombs, other, nr, nc);
  });
  const safe = moves.filter((d) => {
    const [nr, nc] = dest(p.row, p.col, d);
    return !danger.has(idx(nr, nc));
  });
  const safer = safe.filter((d) => {
    const [nr, nc] = dest(p.row, p.col, d);
    return !near.has(idx(nr, nc));
  });
  const pick = (xs: BombItAction[]) => xs[Math.floor(rng() * xs.length)];

  // 1) Survive: flee blasts; prefer cells not hugging the blast radius.
  if (danger.has(idx(p.row, p.col))) {
    if (safer.length) return pick(safer);
    if (safe.length) return pick(safe);
    if (moves.length) return pick(moves);
    return "stay";
  }
  if (near.has(idx(p.row, p.col)) && safer.length) return pick(safer);

  const liveOwn = s.bombs.filter((b) => b.owner === by).length;
  const hereBomb = s.bombs.some((b) => b.row === p.row && b.col === p.col);
  const canBomb = liveOwn < MAX_BOMBS_PER_PLAYER && !hereBomb;
  const hasEscape = () => {
    const future = new Set(
      blastCellsFor(s.grid, { row: p.row, col: p.col, fuse: 0, owner: by }),
    );
    const lethal = (i: number) => future.has(i) || danger.has(i);
    const budget = Math.max(2, Math.floor(FUSE_TICKS / 2));
    const seen = new Set<number>([idx(p.row, p.col)]);
    let frontier: Array<[number, number]> = [[p.row, p.col]];
    for (let step = 0; step < budget && frontier.length > 0; step++) {
      const next: Array<[number, number]> = [];
      for (const [r, c] of frontier) {
        for (const d of dirs) {
          const [nr, nc] = dest(r, c, d);
          const ni = idx(nr, nc);
          if (seen.has(ni)) continue;
          if (!canMoveTo(s.grid, s.bombs, other, nr, nc)) continue;
          seen.add(ni);
          if (!lethal(ni)) return true;
          next.push([nr, nc]);
        }
      }
      frontier = next;
    }
    return false;
  };
  const crateInDir = (d: BombItAction) => {
    const [nr, nc] = dest(p.row, p.col, d);
    return (
      nr >= 0 &&
      nr < GRID_H &&
      nc >= 0 &&
      nc < GRID_W &&
      s.grid[idx(nr, nc)] === CELL_CRATE
    );
  };

  const dist = manhattan(p, other);
  const toward = dirs.filter((d) => {
    const [nr, nc] = dest(p.row, p.col, d);
    return manhattan({ row: nr, col: nc }, other) < dist;
  });
  const towardSafe = toward.filter((d) => safe.includes(d));

  // 2) Rare attack bomb — only on a clear line within blast reach.
  const inLine =
    other.alive && (p.row === other.row || p.col === other.col) && dist <= BLAST_RADIUS;
  if (canBomb && inLine && hasEscape() && rng() < 0.28) return "bomb";

  // 3) Pursue when safe.
  if (towardSafe.length) return pick(towardSafe);

  // 4) Crate blocks all pursuit paths → bomb it open (still rare).
  if (canBomb && towardSafe.length === 0 && toward.some(crateInDir) && hasEscape() && rng() < 0.35) {
    return "bomb";
  }

  // 5) Wander safely — no opportunistic crate bombing.
  if (safer.length) return pick(safer);
  if (safe.length) return pick(safe);
  return "stay";
}

export class BombItProtocol implements Protocol<BombItState, BombItMove> {
  readonly name = "bomb_it.v1";

  initialState(ctx: ProtocolContext): BombItState {
    const seed = seedFromTunnelId(ctx.tunnelId);
    return {
      tick: 0n,
      seed,
      grid: buildGrid(seed),
      players: [
        spawn(SPAWN_A.row, SPAWN_A.col),
        spawn(SPAWN_B.row, SPAWN_B.col),
      ],
      bombs: [],
      winner: null,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
    };
  }

  applyMove(state: BombItState, move: BombItMove, by: Party): BombItState {
    if (this.isTerminal(state)) {
      throw new Error("game over: bomb-it is already decided");
    }
    // Integrity: a seat may only carry its OWN action (hardens vs a forged opponent move).
    if (by === "A" && move.b !== undefined)
      throw new Error("A cannot submit B's action");
    if (by === "B" && move.a !== undefined)
      throw new Error("B cannot submit A's action");

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

    return {
      tick,
      seed: state.seed,
      grid,
      players,
      bombs,
      winner,
      balanceA,
      balanceB,
      total: state.total,
    };
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
      parts.push(
        u64ToBeBytes(p.row),
        u64ToBeBytes(p.col),
        new Uint8Array([p.alive ? 1 : 0]),
      );
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
      new Uint8Array([
        s.winner === "A"
          ? 1
          : s.winner === "B"
            ? 2
            : s.winner === "draw"
              ? 3
              : 0,
      ]),
    );
    return concatBytes(parts);
  }

  balances(s: BombItState): Balances {
    return { a: s.balanceA, b: s.balanceB };
  }

  isTerminal(s: BombItState): boolean {
    return s.winner !== null;
  }

  randomMove(s: BombItState, by: Party, rng: () => number): BombItMove | null {
    if (this.isTerminal(s)) return null;
    const action = hunterAction(s, by, rng);
    return by === "A" ? { a: action } : { b: action };
  }
}
