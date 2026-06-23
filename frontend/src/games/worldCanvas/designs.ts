/**
 * Agent drawing-MODE catalog — what each "Agent AI" bot lays onto the world wall.
 *
 * Every mode is a lazy STROKE GENERATOR: `strokes(ctx)` yields integer cells in
 * REVEAL ORDER, one at a time, and the agent loop co-signs each yielded cell as
 * exactly one tunnel move (1 cell = 1 verified co-sign = ~1 TPS). The ONLY place a
 * float path becomes integer cells is the shared {@link rasterizeStroke} funnel, so
 * every mode is smooth-by-construction while the wire stays a frozen integer move.
 *
 * Two layers (world-canvas-design.md §10.4):
 *   1. A generator produces float points (lines, splines, spirals, flow streamlines)
 *      in REGION-LOCAL cell space, clamped to the mode's footprint box.
 *   2. `rasterizeStroke` walks each polyline at sub-cell spacing and stamps a round
 *      footprint of `radius` per step, deduping within the stroke.
 *
 * Each mode also carries a `density` class and a `footprint`: density feeds the
 * agent loop's per-tick BATCH (dense modes burst TPS, sparse modes sip), and the
 * footprint sizes the agent's non-overlapping world slot + its endless-mode cell cap.
 */

import {
  type Vec2,
  inPolygon,
  starPolygon,
  clamp,
  catmullRomPath,
  makeValueNoise2D,
} from "./geometry";

/** One painted cell as an offset from a region's top-left origin + its palette color. */
export interface DesignCell {
  /** Column offset from the region origin (0-based, within the footprint). */
  dx: number;
  /** Row offset from the region origin (0-based, within the footprint). */
  dy: number;
  /** Palette index in `[0, 16)`. */
  color: number;
}

/** Per-region inputs handed to a mode's stroke generator. */
export interface ModeContext {
  /** Footprint width in cells — strokes are clamped to `[0, width)`. */
  width: number;
  /** Footprint height in cells — strokes are clamped to `[0, height)`. */
  height: number;
  /** Region-seeded PRNG (`[0,1)`), so each region's art is varied yet reproducible. */
  rng: () => number;
  /** Palette size; a cell's color is in `[0, numColors)`. */
  numColors: number;
  /** Monotonic region index — drives deterministic rotations (e.g. the flag picker). */
  index: number;
}

/** Stable id for an agent drawing mode (the registry key + the picker value). */
export type AgentModeId =
  | "artist"
  | "scatter"
  | "filler"
  | "sweep"
  | "scribble"
  | "calligraphy"
  | "geometric"
  | "flow"
  | "wash"
  | "stipple";

/** Visual family used to GROUP the Intelligence pills in the UI. */
export type AgentModeGroup = "art" | "gesture" | "structure" | "fluid";

/** TPS class — maps to the agent loop's per-tick batch size (the burst lever). */
export type AgentDensity = "sparse" | "medium" | "dense";

/** A registered agent drawing mode. A new mode = one registry entry, zero UI wiring. */
export interface AgentDrawMode {
  id: AgentModeId;
  /** Short pill label (e.g. "Flow field"). */
  label: string;
  /** Tooltip describing the mode's character. */
  title: string;
  group: AgentModeGroup;
  /** Cell box this mode draws within — sizes the placement slot + endless-mode cap. */
  footprint: { width: number; height: number };
  /** TPS class → per-tick batch factor (sparse sips, dense bursts). */
  density: AgentDensity;
  /** Lazy stream of integer cells in reveal order. Finite modes end; endless modes
   *  (flow / scribble) yield forever and the caller relocates at the region cap. */
  strokes(ctx: ModeContext): Iterator<DesignCell>;
}

// ── Palette references (indices into ui/tokens.ts PALETTE) ────────────────────────
const RED = 5;
const YELLOW = 8;
const WHITE = 0;
/** Dark "ink" colors for Calligraphy nib swooshes. */
const INK_COLORS = [3, 7, 12] as const;
/** Clean structural line colors for Geometric / Stipple. */
const STRUCT_COLORS = [13, 0, 11, 12, 3] as const;
/** Angle→color cycle for Flow field (color by streamline direction). */
const FLOW_WHEEL = [13, 11, 9, 8, 6, 5, 15, 14, 12] as const;
/** Palette ramps a Wash fills along (soft gradient color fields). */
const WASH_RAMPS: readonly (readonly number[])[] = [
  [12, 13, 11, 0], // blue → cyan → white
  [5, 6, 8, 0], // red → orange → yellow → white
  [14, 15, 4, 0], // purple → pink → white
  [10, 9, 8, 0], // green → light-green → yellow
];

/** Keep a generated cell inside its mode's footprint box (enforces non-overlap). */
function inBox(c: DesignCell, w: number, h: number): boolean {
  return c.dx >= 0 && c.dx < w && c.dy >= 0 && c.dy < h;
}

/**
 * THE float→integer funnel. Walk each polyline segment at sub-cell `spacing`, and at
 * every step stamp a round footprint of `radius` (≈πr² cells), deduping cells within
 * this call so a slow/overlapping path doesn't emit the same cell twice in a row.
 * Returns integer {@link DesignCell}s in reveal order. Every mode rasterizes through
 * here, so all modes are smooth-by-construction and the wire stays integer.
 */
export function rasterizeStroke(
  points: Vec2[],
  radius: number,
  spacing: number,
  color: number,
): DesignCell[] {
  const out: DesignCell[] = [];
  const seen = new Set<string>();
  const r = Math.max(0, radius);
  const ri = Math.max(0, Math.round(r));
  const r2 = r * r + 0.01;
  const stamp = (px: number, py: number) => {
    const bx = Math.round(px);
    const by = Math.round(py);
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const gx = bx + dx;
        const gy = by + dy;
        const k = `${gx},${gy}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ dx: gx, dy: gy, color });
      }
    }
  };
  if (points.length === 0) return out;
  if (points.length === 1) {
    stamp(points[0].x, points[0].y);
    return out;
  }
  const step = Math.max(0.1, spacing);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      stamp(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    }
  }
  return out;
}

// ── Flag builders (Artist mode) ───────────────────────────────────────────────────

interface FlagDesign {
  name: string;
  width: number;
  height: number;
  cells: DesignCell[];
}

/** Cờ đỏ sao vàng — red field with a centered golden five-pointed star. */
function buildVietnam(): FlagDesign {
  const width = 30;
  const height = 20;
  const star = starPolygon(width / 2, height / 2, 8.4, 3.5);
  const field: DesignCell[] = [];
  const emblem: DesignCell[] = [];
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      field.push({ dx, dy, color: RED });
      if (inPolygon(dx + 0.5, dy + 0.5, star)) emblem.push({ dx, dy, color: YELLOW });
    }
  }
  return { name: "Vietnam", width, height, cells: [...field, ...emblem] };
}

/** Hinomaru — white field with a centered red disc. */
function buildJapan(): FlagDesign {
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

const VIETNAM_FLAG = buildVietnam();
const JAPAN_FLAG = buildJapan();
/** Vietnam-heavy 3:1 rotation; the first flag (index 0) is always Vietnam. */
const FLAG_ROTATION: readonly FlagDesign[] = [
  VIETNAM_FLAG,
  VIETNAM_FLAG,
  VIETNAM_FLAG,
  JAPAN_FLAG,
];

// ── Stroke generators ─────────────────────────────────────────────────────────────

/** Artist: lay a pre-baked flag (field cells, then emblem over-paint) cell-by-cell. */
function* artistStrokes(ctx: ModeContext): Generator<DesignCell> {
  const flag = FLAG_ROTATION[ctx.index % FLAG_ROTATION.length];
  for (const c of flag.cells) yield c;
}

/** Scatter: a field of random cells in random colors — noise spray. */
function* scatterStrokes(ctx: ModeContext): Generator<DesignCell> {
  const total = ctx.width * ctx.height;
  for (let i = 0; i < total; i++) {
    yield {
      dx: Math.floor(ctx.rng() * ctx.width),
      dy: Math.floor(ctx.rng() * ctx.height),
      color: Math.floor(ctx.rng() * ctx.numColors),
    };
  }
}

/** Filler: one solid color flood-filled from the center outward (BFS diamond). */
function* fillerStrokes(ctx: ModeContext): Generator<DesignCell> {
  const { width, height } = ctx;
  const color = Math.floor(ctx.rng() * ctx.numColors);
  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  const seen = new Set<number>();
  const queue: [number, number][] = [[width >> 1, height >> 1]];
  seen.add((height >> 1) * width + (width >> 1));
  let head = 0;
  while (head < queue.length) {
    const [x, y] = queue[head++];
    yield { dx: x, dy: y, color };
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
}

/** Sweep (vẽ dài): one long, gently curving ribbon that bounces inside the box, with
 *  a slow color drift — big-footprint gesture strokes that burst TPS. */
function* sweepStrokes(ctx: ModeContext): Generator<DesignCell> {
  const { width: w, height: h } = ctx;
  const r = 3;
  const spacing = 1.4;
  let x = r + ctx.rng() * (w - 2 * r);
  let y = r + ctx.rng() * (h - 2 * r);
  let heading = ctx.rng() * Math.PI * 2;
  let color = Math.floor(ctx.rng() * ctx.numColors);
  const len = 200 + Math.floor(ctx.rng() * 400);
  let seg: Vec2[] = [{ x, y }];
  for (let i = 0; i < len; i++) {
    heading += (ctx.rng() - 0.5) * 0.5;
    x += Math.cos(heading) * 1.6;
    y += Math.sin(heading) * 1.6;
    if (x < r) {
      x = r;
      heading = Math.PI - heading;
    } else if (x > w - 1 - r) {
      x = w - 1 - r;
      heading = Math.PI - heading;
    }
    if (y < r) {
      y = r;
      heading = -heading;
    } else if (y > h - 1 - r) {
      y = h - 1 - r;
      heading = -heading;
    }
    seg.push({ x, y });
    if (seg.length >= 12) {
      for (const c of rasterizeStroke(seg, r, spacing, color)) {
        if (inBox(c, w, h)) yield c;
      }
      seg = [{ x, y }];
      if (ctx.rng() < 0.25) color = (color + 1) % ctx.numColors;
    }
  }
  for (const c of rasterizeStroke(seg, r, spacing, color)) {
    if (inBox(c, w, h)) yield c;
  }
}

/** Scribble (nguệch ngoạc): a momentum random-walk bouncing in a loose box — an
 *  energetic organic doodle. ENDLESS; the agent loop relocates at the region cap. */
function* scribbleStrokes(ctx: ModeContext): Generator<DesignCell> {
  const { width: w, height: h } = ctx;
  const r = 1 + Math.floor(ctx.rng() * 2);
  const spacing = 1.2;
  let x = w / 2;
  let y = h / 2;
  let vx = (ctx.rng() - 0.5) * 2;
  let vy = (ctx.rng() - 0.5) * 2;
  let color = Math.floor(ctx.rng() * ctx.numColors);
  let seg: Vec2[] = [{ x, y }];
  for (;;) {
    vx += (ctx.rng() - 0.5) * 0.8;
    vy += (ctx.rng() - 0.5) * 0.8;
    const sp = Math.hypot(vx, vy) || 1;
    const maxSp = 1.8;
    if (sp > maxSp) {
      vx = (vx / sp) * maxSp;
      vy = (vy / sp) * maxSp;
    }
    x += vx;
    y += vy;
    if (x < r) {
      x = r;
      vx = -vx;
    } else if (x > w - 1 - r) {
      x = w - 1 - r;
      vx = -vx;
    }
    if (y < r) {
      y = r;
      vy = -vy;
    } else if (y > h - 1 - r) {
      y = h - 1 - r;
      vy = -vy;
    }
    seg.push({ x, y });
    if (seg.length >= 10) {
      for (const c of rasterizeStroke(seg, r, spacing, color)) {
        if (inBox(c, w, h)) yield c;
      }
      seg = [{ x, y }];
      if (ctx.rng() < 0.05) color = Math.floor(ctx.rng() * ctx.numColors);
    }
  }
}

/** Calligraphy: a Catmull-Rom swoosh through a few control points, the nib radius
 *  modulated by path speed (fast → thin, slow → thick) — the purest "no-pixel" look. */
function* calligraphyStrokes(ctx: ModeContext): Generator<DesignCell> {
  const { width: w, height: h } = ctx;
  const n = 3 + Math.floor(ctx.rng() * 3);
  const ctrls: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    ctrls.push({ x: 4 + ctx.rng() * (w - 8), y: 4 + ctx.rng() * (h - 8) });
  }
  const path = catmullRomPath(ctrls, 14);
  const color = INK_COLORS[Math.floor(ctx.rng() * INK_COLORS.length)];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const speed = Math.hypot(b.x - a.x, b.y - a.y);
    const r = clamp(3.2 - speed * 0.8, 0.8, 3.4);
    for (const c of rasterizeStroke([a, b], r, 0.9, color)) {
      if (inBox(c, w, h)) yield c;
    }
  }
}

/** Geometric (cấu trúc): one of grid / Archimedean-spiral / rings+starburst, thin
 *  brush, 1–2 structural colors — clean architectural / mathematical figures. */
function* geometricStrokes(ctx: ModeContext): Generator<DesignCell> {
  const { width: w, height: h } = ctx;
  const cx = w / 2;
  const cy = h / 2;
  const c1 = STRUCT_COLORS[Math.floor(ctx.rng() * STRUCT_COLORS.length)];
  const c2 = STRUCT_COLORS[Math.floor(ctx.rng() * STRUCT_COLORS.length)];
  const r = 1;
  const spacing = 1.0;
  const variant = ctx.index % 3;
  if (variant === 0) {
    const gap = 4;
    for (let gx = 2; gx < w - 1; gx += gap) {
      for (const c of rasterizeStroke([{ x: gx, y: 2 }, { x: gx, y: h - 2 }], r, spacing, c1)) {
        if (inBox(c, w, h)) yield c;
      }
    }
    for (let gy = 2; gy < h - 1; gy += gap) {
      for (const c of rasterizeStroke([{ x: 2, y: gy }, { x: w - 2, y: gy }], r, spacing, c2)) {
        if (inBox(c, w, h)) yield c;
      }
    }
  } else if (variant === 1) {
    const maxT = 4 * Math.PI * 2;
    const a = Math.min(w, h) / 2 / maxT;
    const pts: Vec2[] = [];
    for (let t = 0; t <= maxT; t += 0.15) {
      pts.push({ x: cx + a * t * Math.cos(t), y: cy + a * t * Math.sin(t) });
    }
    for (const c of rasterizeStroke(pts, r, spacing, c1)) {
      if (inBox(c, w, h)) yield c;
    }
  } else {
    const rings = Math.max(1, Math.floor(Math.min(w, h) / 2 / 3));
    for (let ringIdx = 1; ringIdx <= rings; ringIdx++) {
      const rad = ringIdx * 3;
      const pts: Vec2[] = [];
      for (let t = 0; t <= Math.PI * 2 + 0.2; t += 0.25) {
        pts.push({ x: cx + rad * Math.cos(t), y: cy + rad * Math.sin(t) });
      }
      for (const c of rasterizeStroke(pts, r, spacing, c1)) {
        if (inBox(c, w, h)) yield c;
      }
    }
    for (let k = 0; k < 12; k++) {
      const ang = (k / 12) * Math.PI * 2;
      const end = { x: cx + Math.cos(ang) * (w / 2), y: cy + Math.sin(ang) * (h / 2) };
      for (const c of rasterizeStroke([{ x: cx, y: cy }, end], r, spacing, c2)) {
        if (inBox(c, w, h)) yield c;
      }
    }
  }
}

/** Flow field: K particles trace streamlines of a value-noise angle field, colored by
 *  direction; particles respawn on exit/age → silky parallel currents. ENDLESS. */
function* flowStrokes(ctx: ModeContext): Generator<DesignCell> {
  const { width: w, height: h } = ctx;
  const noise = makeValueNoise2D(ctx.rng);
  const angleAt = (x: number, y: number) => noise(x * 0.06, y * 0.06) * Math.PI * 4;
  const colorAt = (a: number) => {
    const t = (((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
    return FLOW_WHEEL[Math.min(FLOW_WHEEL.length - 1, Math.floor(t * FLOW_WHEEL.length))];
  };
  const K = 6;
  const parts = Array.from({ length: K }, () => ({
    x: ctx.rng() * w,
    y: ctx.rng() * h,
    life: 0,
  }));
  for (;;) {
    for (const p of parts) {
      const a = angleAt(p.x, p.y);
      const nx = p.x + Math.cos(a) * 1.4;
      const ny = p.y + Math.sin(a) * 1.4;
      for (const c of rasterizeStroke([{ x: p.x, y: p.y }, { x: nx, y: ny }], 1, 1.0, colorAt(a))) {
        if (inBox(c, w, h)) yield c;
      }
      p.x = nx;
      p.y = ny;
      p.life++;
      if (p.life > 120 || p.x < 0 || p.x >= w || p.y < 0 || p.y >= h) {
        p.x = ctx.rng() * w;
        p.y = ctx.rng() * h;
        p.life = 0;
      }
    }
  }
}

/** Wash: a radial or vertical fill following a palette ramp with a dithered edge — a
 *  soft gradient color field. Fills the whole footprint (very high TPS for one region). */
function* washStrokes(ctx: ModeContext): Generator<DesignCell> {
  const { width: w, height: h } = ctx;
  const ramp = WASH_RAMPS[Math.floor(ctx.rng() * WASH_RAMPS.length)];
  const radial = ctx.rng() < 0.5;
  if (radial) {
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.hypot(w / 2, h / 2) || 1;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const d = Math.hypot(dx - cx, dy - cy) / maxR;
        const bump = ctx.rng() < 0.12 ? 1 : 0;
        const ci = clamp(Math.floor(d * ramp.length) + bump, 0, ramp.length - 1);
        yield { dx, dy, color: ramp[ci] };
      }
    }
  } else {
    for (let dy = 0; dy < h; dy++) {
      const ci = clamp(Math.floor((dy / h) * ramp.length), 0, ramp.length - 1);
      for (let dx = 0; dx < w; dx++) {
        const cc = ctx.rng() < 0.12 ? ramp[clamp(ci + 1, 0, ramp.length - 1)] : ramp[ci];
        yield { dx, dy, color: cc };
      }
    }
  }
}

/** Stipple: Poisson-disc-spaced dabs, denser toward the center — an airy pointillist
 *  cloud (the low-TPS contrast mode). */
function* stippleStrokes(ctx: ModeContext): Generator<DesignCell> {
  const { width: w, height: h } = ctx;
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.hypot(w / 2, h / 2) || 1;
  const color = STRUCT_COLORS[Math.floor(ctx.rng() * STRUCT_COLORS.length)];
  const minD = 2.2;
  const accepted: Vec2[] = [];
  const tries = w * h;
  for (let i = 0; i < tries; i++) {
    const x = ctx.rng() * w;
    const y = ctx.rng() * h;
    // Denser near the center: accept probability falls off toward the edge.
    const d = Math.hypot(x - cx, y - cy) / maxR;
    if (ctx.rng() > 1 - d * 0.85) continue;
    let ok = true;
    for (const p of accepted) {
      if (Math.hypot(p.x - x, p.y - y) < minD) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    accepted.push({ x, y });
    yield { dx: Math.floor(x), dy: Math.floor(y), color };
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────────

/**
 * The agent drawing-mode registry. The Intelligence picker maps `Object.values` of
 * this (grouped by `group`); the agent loop reads `density` for its per-tick batch
 * and `footprint` for slot sizing. Add a mode = add one entry here.
 */
export const AGENT_MODES: Record<AgentModeId, AgentDrawMode> = {
  artist: {
    id: "artist",
    label: "Artist",
    title: "Lays the flag designs (Vietnam / Japan), field then emblem",
    group: "art",
    footprint: { width: 30, height: 20 },
    density: "medium",
    strokes: artistStrokes,
  },
  calligraphy: {
    id: "calligraphy",
    label: "Calligraphy",
    title: "Tapered ink swooshes — nib radius follows path speed",
    group: "art",
    footprint: { width: 44, height: 36 },
    density: "medium",
    strokes: calligraphyStrokes,
  },
  stipple: {
    id: "stipple",
    label: "Stipple",
    title: "Airy pointillist dabs, denser toward the center",
    group: "art",
    footprint: { width: 36, height: 30 },
    density: "sparse",
    strokes: stippleStrokes,
  },
  sweep: {
    id: "sweep",
    label: "Sweep",
    title: "Long curving ribbon gestures (vẽ dài) with slow color drift",
    group: "gesture",
    footprint: { width: 48, height: 40 },
    density: "dense",
    strokes: sweepStrokes,
  },
  scribble: {
    id: "scribble",
    label: "Scribble",
    title: "Energetic momentum doodle (nguệch ngoạc), endless",
    group: "gesture",
    footprint: { width: 36, height: 30 },
    density: "medium",
    strokes: scribbleStrokes,
  },
  geometric: {
    id: "geometric",
    label: "Geometric",
    title: "Grids / spirals / lattices (cấu trúc), thin structural lines",
    group: "structure",
    footprint: { width: 40, height: 40 },
    density: "dense",
    strokes: geometricStrokes,
  },
  flow: {
    id: "flow",
    label: "Flow field",
    title: "Silky parallel currents traced from a noise field, endless",
    group: "fluid",
    footprint: { width: 48, height: 44 },
    density: "dense",
    strokes: flowStrokes,
  },
  wash: {
    id: "wash",
    label: "Wash",
    title: "Soft gradient color fill along a palette ramp",
    group: "fluid",
    footprint: { width: 40, height: 30 },
    density: "dense",
    strokes: washStrokes,
  },
  scatter: {
    id: "scatter",
    label: "Scatter",
    title: "Random cells in random colors — noise spray",
    group: "fluid",
    footprint: { width: 26, height: 18 },
    density: "medium",
    strokes: scatterStrokes,
  },
  filler: {
    id: "filler",
    label: "Filler",
    title: "One solid color flooding outward from the center",
    group: "fluid",
    footprint: { width: 24, height: 18 },
    density: "dense",
    strokes: fillerStrokes,
  },
};

/** Default mode for a freshly spawned agent: Scribble — random, endless, dense, no
 *  setup. The goal is raw co-signed TPS, so a fresh agent immediately doodles fast;
 *  the artistic modes + templates stay available but are secondary. */
export const DEFAULT_AGENT_MODE: AgentModeId = "scribble";

/** Order the Intelligence picker renders mode groups in. */
export const AGENT_MODE_GROUPS: readonly AgentModeGroup[] = [
  "art",
  "gesture",
  "structure",
  "fluid",
];

/** Human-readable caption per group, for the grouped Intelligence rows. */
export const AGENT_GROUP_LABELS: Record<AgentModeGroup, string> = {
  art: "Art",
  gesture: "Gesture",
  structure: "Structure",
  fluid: "Fluid",
};

/** Largest footprint across all modes — sizes the global non-overlapping world slot. */
export const MAX_FOOTPRINT_W = Math.max(
  ...Object.values(AGENT_MODES).map((m) => m.footprint.width),
);
export const MAX_FOOTPRINT_H = Math.max(
  ...Object.values(AGENT_MODES).map((m) => m.footprint.height),
);
