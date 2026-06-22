/**
 * Battleship opponent AI — shot selection only.
 *
 * The bot's whole "intelligence" is choosing which cell to fire at next; the
 * rest of a turn (committing, revealing with a Merkle proof) is forced by the
 * protocol and lives in `selfPlay.ts`. That single decision is split out here so
 * its difficulty can be tuned independently of the move driver, and so the same
 * strategy can drive vs-bot play, the self-play simulation, and tests.
 *
 * Two things happen on a turn: HUNT for a fresh ship, and (once something is
 * hit) TARGET to finish it. The difficulty ladder swaps how each is done:
 *
 *   easy   — random hunt, chase a hit's neighbours. Wastes lots of shots.
 *   normal — parity hunt (only one checkerboard colour: the 2-cell ship always
 *            covers one, so this never misses a ship yet halves blind shots) and
 *            line-following target (fire the open ends of a run of hits).
 *   hard   — probability density for BOTH phases: score every open cell by how
 *            many placements of the still-unsunk fleet could cover it (placements
 *            blocked by misses and by sunk ships), and fire the maximum. This is
 *            deterministic, concentrates fire where ships must be, and finishes
 *            wounded ships without spraying — i.e. it plays, it doesn't guess.
 *
 * The density model leans on the Milton-Bradley rule that ships never touch (not
 * even diagonally): a 4-connected run of hits is therefore exactly one ship, so
 * a run that can no longer grow is provably SUNK. Sunk ships are removed from the
 * fleet still being searched, and their 8-neighbourhood is marked unplaceable.
 */

import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { otherParty } from "sui-tunnel-ts/protocol/Protocol";
import type { BattleshipState, ShotResult } from "../protocol/battleship";
import {
  BOARD_SIZE,
  CELL_COUNT,
  FLEET,
  cellAt,
  colOf,
  inBounds,
  rowOf,
} from "./fleet";

export type BotDifficulty = "easy" | "normal" | "hard";

/** How the bot searches for an untouched ship. */
export type HuntStrategy = "random" | "parity" | "density";

/** Difficulty applied when a caller doesn't pick one. */
export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = "normal";

/** The order shown in pickers, weakest first. */
export const BOT_DIFFICULTIES: readonly BotDifficulty[] = [
  "easy",
  "normal",
  "hard",
];

/**
 * The strategy knobs behind a difficulty. `hunt: "density"` supersedes the
 * chase/line flags (it does its own, smarter targeting), so they only matter for
 * the random/parity hunts.
 */
export interface BotConfig {
  readonly difficulty: BotDifficulty;
  readonly label: string;
  /** After an unresolved hit, fire its open orthogonal neighbours instead of hunting blind. */
  readonly chaseHits: boolean;
  /** Once ≥2 hits are collinear-adjacent, fire the open ends of that run first. */
  readonly followLine: boolean;
  /** How blind search picks cells. */
  readonly hunt: HuntStrategy;
}

export const BOT_CONFIGS: Record<BotDifficulty, BotConfig> = {
  easy: {
    difficulty: "easy",
    label: "Easy",
    chaseHits: true,
    followLine: false,
    hunt: "random",
  },
  normal: {
    difficulty: "normal",
    label: "Normal",
    chaseHits: true,
    followLine: true,
    hunt: "parity",
  },
  hard: {
    difficulty: "hard",
    label: "Hard",
    chaseHits: true,
    followLine: true,
    hunt: "density",
  },
};

const ORTHO: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

const FLEET_SIZES: readonly number[] = FLEET.map((s) => s.size);

function shotsAtBoard(state: BattleshipState, defender: Party): ShotResult[] {
  return defender === "A" ? state.shotsAtA : state.shotsAtB;
}

function orthoNeighbors(cell: number): number[] {
  const r = rowOf(cell);
  const c = colOf(cell);
  const out: number[] = [];
  for (const [dr, dc] of ORTHO) {
    if (inBounds(r + dr, c + dc)) out.push(cellAt(r + dr, c + dc));
  }
  return out;
}

/** The 8 cells touching `cell` (orthogonal + diagonal), clipped to the board. */
function neighbors8(cell: number): number[] {
  const r = rowOf(cell);
  const c = colOf(cell);
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if ((dr || dc) && inBounds(r + dr, c + dc))
        out.push(cellAt(r + dr, c + dc));
    }
  }
  return out;
}

function openCells(fired: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (let cell = 0; cell < CELL_COUNT; cell++)
    if (!fired.has(cell)) out.push(cell);
  return out;
}

/** Pick a uniformly-random member of a non-empty pool. */
function pickFrom(pool: number[], rng: () => number): number {
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/** The cells of a straight `size`-long ship anchored at `cell`, or null if it runs off the board. */
function placementRun(
  cell: number,
  size: number,
  horizontal: boolean,
): number[] | null {
  const r = rowOf(cell);
  const c = colOf(cell);
  const cells: number[] = [];
  for (let i = 0; i < size; i++) {
    const rr = horizontal ? r : r + i;
    const cc = horizontal ? c + i : c;
    if (!inBounds(rr, cc)) return null;
    cells.push(cellAt(rr, cc));
  }
  return cells;
}

/**
 * Open cells that extend a run of ≥2 collinear-adjacent hits, at either end.
 * Empty when no two hits are adjacent in a line (then the caller falls back to
 * neighbours). Both ends are covered because every direction is tried per hit.
 */
function lineExtensions(
  hits: ReadonlySet<number>,
  fired: ReadonlySet<number>,
): number[] {
  const out: number[] = [];
  for (const h of hits) {
    const r = rowOf(h);
    const c = colOf(h);
    for (const [dr, dc] of ORTHO) {
      // A neighbouring hit in this direction is what makes a line worth following.
      if (!inBounds(r + dr, c + dc) || !hits.has(cellAt(r + dr, c + dc)))
        continue;
      // Walk to the far end of the contiguous hit run, then take the first open cell past it.
      let er = r + dr;
      let ec = c + dc;
      while (inBounds(er + dr, ec + dc) && hits.has(cellAt(er + dr, ec + dc))) {
        er += dr;
        ec += dc;
      }
      if (inBounds(er + dr, ec + dc) && !fired.has(cellAt(er + dr, ec + dc)))
        out.push(cellAt(er + dr, ec + dc));
    }
  }
  return out;
}

interface HitGroups {
  /** Hits on ships still being worked (a run that can still grow into an open cell). */
  active: Set<number>;
  /** Cells of provably-finished ships (a run blocked at both ends). */
  sunk: Set<number>;
  /** The length of each sunk run — used to drop finished ships from the search. */
  sunkSizes: number[];
}

/**
 * Split hits into ships still in play vs. provably-sunk ones. A 4-connected run
 * of hits is one ship (ships never touch); it is sunk once it cannot extend —
 * every cell just past its ends is a miss or the board edge.
 */
function groupHits(
  hits: ReadonlySet<number>,
  fired: ReadonlySet<number>,
): HitGroups {
  const active = new Set<number>();
  const sunk = new Set<number>();
  const sunkSizes: number[] = [];
  const seen = new Set<number>();

  for (const start of hits) {
    if (seen.has(start)) continue;
    // Flood-fill the 4-connected run of hits.
    const run: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop()!;
      run.push(cur);
      for (const n of orthoNeighbors(cur))
        if (hits.has(n) && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
    }

    // Can the run still grow? A single hit may grow any orthogonal direction; a
    // line may only grow along its axis, past either end.
    let canGrow = false;
    if (run.length === 1) {
      canGrow = orthoNeighbors(run[0]).some((n) => !fired.has(n));
    } else {
      const horizontal = new Set(run.map(rowOf)).size === 1;
      const sorted = [...run].sort((a, b) => a - b);
      const lo = sorted[0];
      const hi = sorted[sorted.length - 1];
      const before = horizontal
        ? colOf(lo) > 0
          ? lo - 1
          : null
        : rowOf(lo) > 0
          ? lo - BOARD_SIZE
          : null;
      const after = horizontal
        ? colOf(hi) < BOARD_SIZE - 1
          ? hi + 1
          : null
        : rowOf(hi) < BOARD_SIZE - 1
          ? hi + BOARD_SIZE
          : null;
      canGrow =
        (before !== null && !fired.has(before)) ||
        (after !== null && !fired.has(after));
    }

    if (canGrow) for (const c of run) active.add(c);
    else {
      for (const c of run) sunk.add(c);
      sunkSizes.push(run.length);
    }
  }
  return { active, sunk, sunkSizes };
}

/** Fleet ship sizes minus the ones we've proven sunk. */
function remainingSizes(sunkSizes: number[]): number[] {
  const sizes = [...FLEET_SIZES];
  for (const sunk of sunkSizes) {
    const i = sizes.indexOf(sunk);
    if (i >= 0) sizes.splice(i, 1);
  }
  return sizes;
}

/**
 * Probability-density shot: score each open cell by how many ways an unsunk ship
 * could legally sit over it, then fire the maximum (ties broken by `rng`). A
 * placement is illegal if it covers a miss or a sunk ship or touches one; one
 * that covers a live hit is weighted far higher, so the bot pours fire into
 * finishing a wounded ship before searching again — without ever re-firing.
 */
function densityShot(
  fired: ReadonlySet<number>,
  hits: ReadonlySet<number>,
  rng: () => number,
): number {
  const { active, sunk, sunkSizes } = groupHits(hits, fired);

  // Cells no remaining ship can occupy: misses, sunk ships, and (no-touch rule) the ring around a sunk ship.
  const blocked = new Set<number>();
  for (const c of fired) if (!hits.has(c)) blocked.add(c);
  for (const c of sunk) {
    blocked.add(c);
    for (const n of neighbors8(c)) blocked.add(n);
  }

  const sizes = remainingSizes(sunkSizes);
  const HIT_WEIGHT = 1000; // dominates blind-hunt density so live hits are always chased first
  const score = new Float64Array(CELL_COUNT);

  for (const size of sizes) {
    for (const horizontal of [true, false]) {
      for (let anchor = 0; anchor < CELL_COUNT; anchor++) {
        const cells = placementRun(anchor, size, horizontal);
        if (!cells || cells.some((c) => blocked.has(c))) continue;
        let overlap = 0;
        for (const c of cells) if (active.has(c)) overlap++;
        const weight = overlap > 0 ? HIT_WEIGHT * overlap : 1;
        for (const c of cells) if (!fired.has(c)) score[c] += weight;
      }
    }
  }

  let best = 0;
  const tied: number[] = [];
  for (let c = 0; c < CELL_COUNT; c++) {
    if (fired.has(c) || score[c] === 0) continue;
    if (score[c] > best) {
      best = score[c];
      tied.length = 0;
      tied.push(c);
    } else if (score[c] === best) tied.push(c);
  }
  // No placement fits any open cell (degenerate late game) — just take any open cell.
  return tied.length > 0
    ? pickFrom(tied, rng)
    : pickFrom(openCells(fired), rng);
}

/**
 * The cell `shooter` should fire at next against `defender`'s board, given the
 * shots resolved so far. Never returns an already-fired cell (every board with
 * an unsunk fleet has open cells, so the pool is never empty during play).
 *
 * `rng` is a `() => number` in [0,1) — seed it for deterministic tests.
 */
export function pickShot(
  state: BattleshipState,
  shooter: Party,
  rng: () => number,
  config: BotConfig = BOT_CONFIGS[DEFAULT_BOT_DIFFICULTY],
): number {
  const defender = otherParty(shooter);
  const shots = shotsAtBoard(state, defender);
  const fired = new Set(shots.map((s) => s.cell));
  const hits = new Set(shots.filter((s) => s.isHit).map((s) => s.cell));

  // The density strategy does its own (better) hunting and targeting in one pass.
  if (config.hunt === "density") return densityShot(fired, hits, rng);

  // Target mode: finish off a ship we've already wounded.
  if (config.chaseHits && hits.size > 0) {
    const lines = config.followLine ? lineExtensions(hits, fired) : [];
    const targets =
      lines.length > 0
        ? lines
        : [...hits].flatMap((h) =>
            orthoNeighbors(h).filter((n) => !fired.has(n)),
          );
    if (targets.length > 0) return pickFrom(targets, rng);
  }

  // Hunt mode: search for a fresh ship.
  const open = openCells(fired);
  if (config.hunt === "parity") {
    const parity = open.filter((cell) => (rowOf(cell) + colOf(cell)) % 2 === 0);
    if (parity.length > 0) return pickFrom(parity, rng);
  }
  return pickFrom(open, rng);
}
