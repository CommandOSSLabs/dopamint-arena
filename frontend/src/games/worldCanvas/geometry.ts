/**
 * Shared float-space geometry for the agent drawing modes (designs.ts). These are
 * the pure curve / polygon / field primitives the stroke generators sample BEFORE
 * the single `rasterizeStroke` float→integer funnel snaps them to cells. Nothing
 * here touches the wire — a co-signed move is still an integer cell + palette index.
 *
 * Promoted out of designs.ts so the flag builders, the mode catalog, and (later)
 * the template library all read the same `inPolygon` / `starPolygon`.
 */

/** A continuous point in region-local cell space (pre-rasterization). */
export interface Vec2 {
  x: number;
  y: number;
}

/** Even-odd ray-cast point-in-polygon test (poly is a closed ring of vertices). */
export function inPolygon(px: number, py: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const crosses =
      a.y > py !== b.y > py &&
      px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * The 10 vertices of a regular five-pointed star, top point UP. Screen Y grows
 * downward, so the apex is at `(cx, cy - outer)` and the points fan out at 72°.
 */
export function starPolygon(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
): Vec2[] {
  const pts: Vec2[] = [];
  const deg = Math.PI / 180;
  for (let k = 0; k < 5; k++) {
    const ao = (-90 + 72 * k) * deg;
    pts.push({ x: cx + outer * Math.cos(ao), y: cy + outer * Math.sin(ao) });
    const ai = (-90 + 36 + 72 * k) * deg;
    pts.push({ x: cx + inner * Math.cos(ai), y: cy + inner * Math.sin(ai) });
  }
  return pts;
}

/** Clamp `v` to `[lo, hi]`. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Mulberry32 PRNG — a tiny, fast, well-distributed 32-bit generator. Each agent
 * region is seeded by its index so a mode's "random" art is varied region-to-region
 * yet reproducible (stable markers, no cross-region state). Returns floats in [0,1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One point on a uniform Catmull-Rom segment through p1→p2 (p0/p3 are tangents). */
export function catmullRom(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  t: number,
): Vec2 {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

/**
 * Sample a smooth Catmull-Rom spline through `controls` (endpoints duplicated so
 * the curve reaches them). Feeds Calligraphy's tapered swooshes — a flowing path
 * the nib then rasterizes with speed-modulated radius.
 */
export function catmullRomPath(controls: Vec2[], samplesPerSeg = 12): Vec2[] {
  if (controls.length < 2) return controls.slice();
  const c = [controls[0], ...controls, controls[controls.length - 1]];
  const out: Vec2[] = [];
  for (let i = 1; i < c.length - 2; i++) {
    for (let s = 0; s < samplesPerSeg; s++) {
      out.push(catmullRom(c[i - 1], c[i], c[i + 1], c[i + 2], s / samplesPerSeg));
    }
  }
  out.push(controls[controls.length - 1]);
  return out;
}

/**
 * A coherent 2-D value-noise field in [0,1), seeded by `rng`. Smoothstep-interpolated
 * over a hashed integer lattice — cheap and dependency-free. Flow-field mode reads it
 * as an angle field so K particles trace silky, parallel streamlines.
 */
export function makeValueNoise2D(rng: () => number): (x: number, y: number) => number {
  const salt = (Math.floor(rng() * 0xffffffff) >>> 0) | 1;
  const hash = (x: number, y: number): number => {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + salt) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const v00 = hash(x0, y0);
    const v10 = hash(x0 + 1, y0);
    const v01 = hash(x0, y0 + 1);
    const v11 = hash(x0 + 1, y0 + 1);
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    return a + (b - a) * fy;
  };
}
