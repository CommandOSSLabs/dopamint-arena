/**
 * Pixel Duel kit: two design-bots wage the public paint/own/lock war while each
 * holds a SECRET binary-mask template, then reveal at terminal so the protocol
 * can score coverage (see sui-tunnel-ts/protocol/pixelDuel.ts and ADR 0011).
 *
 * The kit owns BOTH templates + salts (the bot-vs-bot driver case): it commits
 * them up front, hands the protocol the two commitments, and gives each seat's
 * bot only that seat's `(mask, salt, color)`. A bot paints toward its own mask
 * during play, then `plan` returns the `reveal` carrying its mask — `randomMove`
 * structurally cannot produce a reveal, so the kit is the reveal driver.
 *
 * Pure TypeScript only (no React/UI) so it stays inside the agent import
 * boundary — see frontend/src/agent/importBoundary.test.ts.
 */

import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  PixelDuelProtocol,
  type PixelDuelState,
  type PixelDuelMove,
  WIDTH,
  HEIGHT,
  COLOR_A,
  COLOR_B,
  OWNER_A,
  OWNER_B,
  MIN_TEMPLATE_CELLS,
  MAX_TEMPLATE_CELLS,
} from "sui-tunnel-ts/protocol/pixelDuel";
import { computeCommitment, MIN_SALT_LEN } from "sui-tunnel-ts/core/commitment";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";
import { DESIGNS, type PixelDesign } from "./designs";

/**
 * Curated designs whose raw cell count already lands in the protocol's
 * [MIN_TEMPLATE_CELLS, MAX_TEMPLATE_CELLS] band when projected un-clipped:
 * smiley=88, suiDroplet=90, walrus=132. The tiny heart (46) is excluded — it
 * would fail the soft cell-count check at reveal.
 */
const DUEL_DESIGNS: readonly PixelDesign[] = [
  DESIGNS.smiley,
  DESIGNS.suiDroplet,
  DESIGNS.walrus,
];

export interface PixelDuelKitConfig {
  /** Seed for the reproducible template/salt RNG so tests replay deterministically. */
  seed?: number;
  width?: number;
  height?: number;
  cap?: number;
  overwriteLimit?: number;
  /** Amount shifted loser→winner on a decisive coverage result. */
  stake?: bigint;
}

/** A seedable RNG (mulberry32) returning a float in [0,1). Local so the kit has no UI deps. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A salt of >= MIN_SALT_LEN random bytes, drawn from the seeded stream so reveals replay. */
function makeSalt(rng: () => number, len = MIN_SALT_LEN): Uint8Array {
  const salt = new Uint8Array(len);
  for (let i = 0; i < len; i++) salt[i] = Math.floor(rng() * 256) & 0xff;
  return salt;
}

/**
 * Project a design at a RANDOM, fully-on-board location and flatten it to a 0/1
 * mask (1 = any color, 0 = don't-care). Placing it fully on the board keeps the
 * cell count equal to the design's raw count, so a design pre-vetted into the
 * [min,max] band stays in-band regardless of where it lands.
 */
function randomMaskTemplate(
  d: PixelDesign,
  width: number,
  height: number,
  rng: () => number,
): Uint8Array {
  // Top-left offset ranges that keep the whole design on the board.
  const maxOx = Math.max(0, width - d.w);
  const maxOy = Math.max(0, height - d.h);
  const ox = Math.floor(rng() * (maxOx + 1));
  const oy = Math.floor(rng() * (maxOy + 1));

  const mask = new Uint8Array(width * height);
  for (let ty = 0; ty < d.h; ty++) {
    const y = oy + ty;
    if (y < 0 || y >= height) continue;
    for (let tx = 0; tx < d.w; tx++) {
      const x = ox + tx;
      if (x < 0 || x >= width) continue;
      if (d.pixels[ty * d.w + tx] !== 0) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** Count the 1-cells in a 0/1 mask (its template-cell denominator). */
function maskCells(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) n++;
  return n;
}

/**
 * Pick a design whose mask cell count is in-band, project it at a random spot,
 * and return the mask. Distinct designs/locations per seat via the seeded RNG.
 */
function pickTemplate(
  width: number,
  height: number,
  rng: () => number,
  minCells: number,
  maxCells: number,
  designIndex: number,
): Uint8Array {
  const d = DUEL_DESIGNS[designIndex % DUEL_DESIGNS.length]!;
  const mask = randomMaskTemplate(d, width, height, rng);
  const cells = maskCells(mask);
  if (cells < minCells || cells > maxCells) {
    // A curated, fully-on-board design must stay in-band; a miss is a code bug.
    throw new Error(
      `template for "${d.name}" has ${cells} cells, outside [${minCells},${maxCells}]`,
    );
  }
  return mask;
}

/** Each seat's secret material handed to its bot by the kit (the reveal driver). */
interface SeatSecret {
  mask: Uint8Array;
  salt: Uint8Array;
  color: number;
}

/**
 * One seat's commit-reveal material for the FLEET duel path: the secret mask, its
 * salt, the 32-byte commitment to hand the peer, and the forced seat color. In
 * bot-vs-bot over the tunnel each agent generates ONLY its own seat's material
 * (it never sees the opponent's mask), exchanges the `commit`, and the engine
 * builds `PixelDuelProtocol` with both commits. The in-process kit reuses the
 * same generator for both seats from one seeded stream.
 */
export interface DuelSeatMaterial {
  mask: Uint8Array;
  salt: Uint8Array;
  commit: Uint8Array;
  color: number;
}

export interface DuelSeatOptions {
  width?: number;
  height?: number;
  minTemplateCells?: number;
  maxTemplateCells?: number;
  /** Force the design index (else derived from the RNG over DUEL_DESIGNS). */
  designIndex?: number;
}

/**
 * Generate one seat's commit-reveal material from a float-RNG stream: pick an
 * in-band design, project it at a random on-board spot, draw a >=16-byte salt,
 * and commit `(mask, salt)` exactly as the protocol verifies at reveal. Seat A is
 * Sui blue (COLOR_A), seat B pink (COLOR_B). Pure — the caller owns the RNG, so a
 * fleet agent seeds it however it likes and the in-process kit replays it.
 */
export function makeDuelSeatMaterial(
  seat: Party,
  rng: () => number,
  opts: DuelSeatOptions = {},
): DuelSeatMaterial {
  const width = opts.width ?? WIDTH;
  const height = opts.height ?? HEIGHT;
  const minCells = opts.minTemplateCells ?? MIN_TEMPLATE_CELLS;
  const maxCells = opts.maxTemplateCells ?? MAX_TEMPLATE_CELLS;
  const designIndex =
    opts.designIndex ?? Math.floor(rng() * DUEL_DESIGNS.length);
  const mask = pickTemplate(width, height, rng, minCells, maxCells, designIndex);
  const salt = makeSalt(rng);
  const commit = computeCommitment(mask, salt);
  return { mask, salt, commit, color: seat === "A" ? COLOR_A : COLOR_B };
}

/** Seat A leans build, seat B leans contest — biases the fleet bot's play. */
export function duelContestRate(seat: Party): number {
  return seat === "A" ? SEAT_A_CONTEST_RATE : SEAT_B_CONTEST_RATE;
}

/**
 * The fleet's seat bot, exposed so the engine can drive build/contest play and
 * the terminal reveal with the SAME logic the in-process kit uses. The engine
 * holds only its own seat's `(mask, salt, color)` — it never learns the peer's.
 */
export function createDuelSeatBot(
  seat: Party,
  ctx: BotContext,
  material: DuelSeatMaterial,
): GameBot<PixelDuelState, PixelDuelMove> {
  return new PixelDuelBot(
    seat,
    ctx,
    { mask: material.mask, salt: material.salt, color: material.color },
    duelContestRate(seat),
  );
}

/**
 * A design-bot for one seat. During play it paints its OWN mask cells its seat
 * color (build), optionally overpaints opponent-owned unlocked cells to deny
 * coverage (contest), and falls back to securing its own cells; at reveal it
 * emits the seat's secret mask+salt; once over it idles.
 *
 * `contestRate` biases the seat: a high rate (seat B) spends more moves blocking
 * the opponent's territory, a low rate (seat A) stays build-focused. The choice
 * is purely about producing varied, decisive games — coverage scoring (not
 * territory) decides the duel, so contesting only matters when it overwrites an
 * opponent cell that sits on the opponent's secret mask.
 */
class PixelDuelBot implements GameBot<PixelDuelState, PixelDuelMove> {
  private readonly seat: Party;
  private readonly secret: SeatSecret;
  private readonly contestRate: number;
  private readonly rng: () => number;

  constructor(
    seat: Party,
    ctx: BotContext,
    secret: SeatSecret,
    contestRate: number,
  ) {
    this.seat = seat;
    this.secret = secret;
    this.contestRate = contestRate;
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: PixelDuelState): PixelDuelMove | null {
    if (state.phase === "over") return null;

    if (state.phase === "reveal") {
      // The kit is the reveal driver: hand back this seat's committed secret.
      return { kind: "reveal", template: this.secret.mask, salt: this.secret.salt };
    }

    // phase === "play": build / contest / secure, all as legal seat-colored paints.
    const W = state.width;
    const N = state.canvas.length;
    const mine = this.seat === "A" ? OWNER_A : OWNER_B;
    const theirs = this.seat === "A" ? OWNER_B : OWNER_A;
    const color = this.secret.color;
    const open = (i: number) => state.paints[i] < state.overwriteLimit;
    const cx = (W - 1) / 2;
    const cy = (state.height - 1) / 2;
    const dist2 = (i: number) => {
      const x = i % W;
      const y = (i / W) | 0;
      return (x - cx) * (x - cx) + (y - cy) * (y - cy);
    };

    // CONTEST (seat-biased): overpaint an opponent-owned, unlocked cell to block
    // its coverage. Chosen FIRST on a contest roll so a contest-focused seat
    // actively denies; nearest such cell to centre.
    if (this.rng() < this.contestRate) {
      const contest = this.nearestOwned(state, theirs, open, dist2, N);
      if (contest >= 0) {
        return { kind: "paint", x: contest % W, y: (contest / W) | 0, color };
      }
    }

    // BUILD: nearest open mask cell not already mine-and-correct.
    let best = -1;
    let bestKey = Infinity;
    for (let i = 0; i < N; i++) {
      if (this.secret.mask[i] !== 1 || !open(i)) continue;
      if (state.owner[i] === mine && state.canvas[i] === color) continue;
      const key = dist2(i) * N + i;
      if (key < bestKey) {
        bestKey = key;
        best = i;
      }
    }
    if (best >= 0) return { kind: "paint", x: best % W, y: (best / W) | 0, color };

    // CONTEST (fallback): mask fully built — deny the opponent if any cell is open.
    const contest = this.nearestOwned(state, theirs, open, dist2, N);
    if (contest >= 0) {
      return { kind: "paint", x: contest % W, y: (contest / W) | 0, color };
    }

    // SECURE: reinforce my own open mask cells toward their lock (always advances
    // `placed`, so the wire digest changes — satisfies the harness no-op guard).
    best = -1;
    bestKey = Infinity;
    for (let i = 0; i < N; i++) {
      if (this.secret.mask[i] !== 1 || !open(i) || state.owner[i] !== mine) continue;
      const key = dist2(i) * N + i;
      if (key < bestKey) {
        bestKey = key;
        best = i;
      }
    }
    if (best >= 0) return { kind: "paint", x: best % W, y: (best / W) | 0, color };

    // LAST RESORT: any open cell — guarantees progress toward the play→reveal cap.
    for (let i = 0; i < N; i++) {
      if (open(i)) return { kind: "paint", x: i % W, y: (i / W) | 0, color };
    }
    return null; // fully locked — protocol has already transitioned to reveal.
  }

  /** Nearest-to-centre cell owned by `who`, still open. -1 if none. */
  private nearestOwned(
    state: PixelDuelState,
    who: number,
    open: (i: number) => boolean,
    dist2: (i: number) => number,
    N: number,
  ): number {
    let best = -1;
    let bestKey = Infinity;
    for (let i = 0; i < N; i++) {
      if (state.owner[i] !== who || !open(i)) continue;
      const key = dist2(i) * N + i;
      if (key < bestKey) {
        bestKey = key;
        best = i;
      }
    }
    return best;
  }

  confirm(_state: PixelDuelState, _move: PixelDuelMove): void {
    // The mask is fixed and play decisions read live public state; no memory to advance.
  }

  abort(): void {
    // Short-lived instance; secret material is released on garbage collection.
  }
}

/** Seat A leans build, seat B leans contest — variety in otherwise-mirrored play. */
const SEAT_A_CONTEST_RATE = 0.1;
const SEAT_B_CONTEST_RATE = 0.6;

export function createPixelDuelKit(
  config: PixelDuelKitConfig = {},
): GameKit<PixelDuelState, PixelDuelMove> {
  const width = config.width ?? WIDTH;
  const height = config.height ?? HEIGHT;
  const minCells = MIN_TEMPLATE_CELLS;
  const maxCells = MAX_TEMPLATE_CELLS;

  // ONE seeded stream generates both templates + salts so a given seed always
  // reproduces the same duel (and the same committed bytes) across runs. Two
  // DISTINCT designs/locations: seat A takes index 0, seat B index 1.
  const rng = makeRng(config.seed ?? 0xd0e1);
  const seatOpts: DuelSeatOptions = {
    width,
    height,
    minTemplateCells: minCells,
    maxTemplateCells: maxCells,
  };
  const matA = makeDuelSeatMaterial("A", rng, { ...seatOpts, designIndex: 0 });
  const matB = makeDuelSeatMaterial("B", rng, { ...seatOpts, designIndex: 1 });

  const protocol = new PixelDuelProtocol({
    width,
    height,
    cap: config.cap,
    overwriteLimit: config.overwriteLimit,
    stake: config.stake,
    templateCommitA: matA.commit,
    templateCommitB: matB.commit,
    minTemplateCells: minCells,
    maxTemplateCells: maxCells,
  });

  const secrets: Record<Party, SeatSecret> = {
    A: { mask: matA.mask, salt: matA.salt, color: matA.color },
    B: { mask: matB.mask, salt: matB.salt, color: matB.color },
  };

  return {
    id: "pixel-duel",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new PixelDuelBot(
        seat,
        ctx,
        secrets[seat],
        seat === "A" ? SEAT_A_CONTEST_RATE : SEAT_B_CONTEST_RATE,
      ),
    defaultStake: config.stake ?? 100n,
  };
}
