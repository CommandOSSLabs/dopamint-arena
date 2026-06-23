/**
 * Pixel-grid flag designs the Agent-AI bots stamp onto the world wall. Each design
 * is a flat list of cells (offsets from a top-left origin) in REVEAL ORDER — the
 * agent walks them one at a time and EACH cell becomes exactly one co-signed move
 * (1 paint = 1 TPS). The primary design is the **Vietnam flag** (red field + a
 * centered five-pointed yellow star); a second flag (Japan) adds variety.
 *
 * Reveal order is "field first, emblem second": every cell of the rectangle is
 * laid as the field color, THEN the emblem cells (star / disc) are painted on top
 * of the field cells they cover. That over-paint is intentional — it makes the
 * flag read instantly the moment the emblem stamps on, and it exercises the
 * append-only repaint path (a star cell is painted red, then re-painted yellow,
 * each a separate co-signed move) right inside an agent's own drawing.
 *
 * Colors are palette indices (see ui/tokens.ts PALETTE): 5 = red, 8 = yellow,
 * 0 = white.
 */

export interface DesignCell {
  /** Column offset from the design's top-left origin (0-based). */
  dx: number;
  /** Row offset from the design's top-left origin (0-based). */
  dy: number;
  /** Palette index in `[0, 16)`. */
  color: number;
}

export interface PixelDesign {
  /** Short name shown on the agent's marker (e.g. "Vietnam"). */
  name: string;
  width: number;
  height: number;
  /** Cells in paint/reveal order: field cells first, emblem cells (over-paint) last. */
  cells: DesignCell[];
}

const RED = 5;
const YELLOW = 8;
const WHITE = 0;

/** Even-odd ray-cast point-in-polygon test (poly is a closed ring of vertices). */
function inPolygon(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const crosses =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * The 10 vertices of a regular five-pointed star, top point UP. Screen Y grows
 * downward, so the apex is at `(cx, cy - outer)` and the points fan out at 72°.
 */
function starPolygon(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
): [number, number][] {
  const pts: [number, number][] = [];
  const deg = Math.PI / 180;
  for (let k = 0; k < 5; k++) {
    const ao = (-90 + 72 * k) * deg;
    pts.push([cx + outer * Math.cos(ao), cy + outer * Math.sin(ao)]);
    const ai = (-90 + 36 + 72 * k) * deg;
    pts.push([cx + inner * Math.cos(ai), cy + inner * Math.sin(ai)]);
  }
  return pts;
}

/** Cờ đỏ sao vàng — red field with a centered golden five-pointed star. */
function buildVietnam(): PixelDesign {
  const width = 30;
  const height = 20;
  const star = starPolygon(width / 2, height / 2, 8.4, 3.5);
  const field: DesignCell[] = [];
  const emblem: DesignCell[] = [];
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      field.push({ dx, dy, color: RED });
      if (inPolygon(dx + 0.5, dy + 0.5, star)) {
        emblem.push({ dx, dy, color: YELLOW });
      }
    }
  }
  return { name: "Vietnam", width, height, cells: [...field, ...emblem] };
}

/** Hinomaru — white field with a centered red disc. */
function buildJapan(): PixelDesign {
  const width = 30;
  const height = 20;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 6.0;
  const field: DesignCell[] = [];
  const emblem: DesignCell[] = [];
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      field.push({ dx, dy, color: WHITE });
      if (Math.hypot(dx + 0.5 - cx, dy + 0.5 - cy) <= radius) {
        emblem.push({ dx, dy, color: RED });
      }
    }
  }
  return { name: "Japan", width, height, cells: [...field, ...emblem] };
}

export const VIETNAM_FLAG = buildVietnam();
export const JAPAN_FLAG = buildJapan();

/** All available flag designs. */
export const FLAG_DESIGNS: readonly PixelDesign[] = [VIETNAM_FLAG, JAPAN_FLAG];

/**
 * Largest design footprint — used by the placement grid to size world slots so
 * flags never overlap regardless of which design lands in a slot.
 */
export const MAX_DESIGN_WIDTH = Math.max(...FLAG_DESIGNS.map((d) => d.width));
export const MAX_DESIGN_HEIGHT = Math.max(...FLAG_DESIGNS.map((d) => d.height));

/**
 * Pick the design for the n-th flag placed. Vietnam-heavy (3:1) so the wall keeps
 * filling with the Vietnam flag; the very first flag (index 0) is always Vietnam.
 */
const ROTATION: readonly PixelDesign[] = [
  VIETNAM_FLAG,
  VIETNAM_FLAG,
  VIETNAM_FLAG,
  JAPAN_FLAG,
];

export function designForFlagIndex(index: number): PixelDesign {
  return ROTATION[index % ROTATION.length];
}

/**
 * An agent's drawing INTELLIGENCE — what it lays down per region:
 *   - `artist`  walks the flag rotation cell-by-cell (the default, recognizable art).
 *   - `scatter` sprays random cells in random palette colors (chaotic fill).
 *   - `filler`  floods one solid color outward from the region center (a growing blob).
 * Every mode is still a flat list of cells in reveal order, so a tick = one cell =
 * one co-signed move regardless of intelligence.
 */
export type AgentMode = "artist" | "scatter" | "filler";

/** Vivid solid palette indices a Filler picks from (one color per filled region). */
const FILLER_COLORS = [5, 6, 8, 10, 11, 12, 13, 14] as const;

/**
 * Scatter: a field of random cells in random palette colors, walked one per tick.
 * Each region is freshly randomized so no two scatter bursts repeat. Sized within
 * the flag footprint so it shares the same non-overlapping placement slots.
 */
function buildScatter(): PixelDesign {
  const width = 26;
  const height = 18;
  const cells: DesignCell[] = [];
  for (let i = 0; i < width * height; i++) {
    cells.push({
      dx: Math.floor(Math.random() * width),
      dy: Math.floor(Math.random() * height),
      color: Math.floor(Math.random() * 16),
    });
  }
  return { name: "Scatter", width, height, cells };
}

/**
 * Filler: one solid color flood-filled from the region's center outward (BFS), so
 * the cells reveal as an expanding diamond — a contiguous region growing tick by
 * tick. A fresh color per region keeps successive fills visually distinct.
 */
function buildFiller(): PixelDesign {
  const width = 24;
  const height = 18;
  const color = FILLER_COLORS[Math.floor(Math.random() * FILLER_COLORS.length)];
  const neighbors: readonly [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const cells: DesignCell[] = [];
  const seen = new Set<number>();
  const seedX = Math.floor(width / 2);
  const seedY = Math.floor(height / 2);
  const queue: [number, number][] = [[seedX, seedY]];
  seen.add(seedY * width + seedX);
  while (queue.length > 0) {
    const [x, y] = queue.shift()!;
    cells.push({ dx: x, dy: y, color });
    for (const [ddx, ddy] of neighbors) {
      const nx = x + ddx;
      const ny = y + ddy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const k = ny * width + nx;
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return { name: "Filler", width, height, cells };
}

/**
 * Pick the design for an agent's next region given its drawing intelligence. Artist
 * walks the deterministic flag rotation; Scatter/Filler return a freshly-randomized
 * pattern each call (so every region they fill looks new).
 */
export function designForMode(mode: AgentMode, flagIndex: number): PixelDesign {
  if (mode === "scatter") return buildScatter();
  if (mode === "filler") return buildFiller();
  return designForFlagIndex(flagIndex);
}
