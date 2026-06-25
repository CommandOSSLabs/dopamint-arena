/**
 * The float→integer funnel for stamp templates: turn a vector {@link StrokeTemplate}
 * (smooth bands + even-odd regions) into integer paint cells in reveal order. It is
 * the ONLY place a template touches the cell grid, and it reuses the agent modes'
 * proven `rasterizeStroke` (round-nib polyline walk) + `inPolygon`, so a stamped cell
 * is byte-identical to any other co-signed paint — the wire stays a frozen integer move.
 *
 * `estimateMoves` is the burst guard: it returns the exact cell count a stamp will
 * co-sign at a scale, so the UI can show "≈ N paints" and the stamper can chunk it.
 */
import { rasterizeStroke, type DesignCell } from "../designs";
import { inPolygon, type Vec2 } from "../geometry";
import type {
  StrokeTemplate,
  TemplateFillPath,
  TemplateStrokePath,
  RasterizedTemplate,
} from "./types";

/** Sub-cell step along a stroke band (smaller = smoother, more cells). */
const DAB_SPACING = 0.85;
/** Floor on a rasterized nib radius so a thin band still lays a connected line. */
const MIN_RADIUS = 0.55;

/** Even-odd "inside" across MANY rings (outer ring minus holes): XOR of each test. */
function inRings(px: number, py: number, rings: Vec2[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    if (inPolygon(px, py, ring)) inside = !inside;
  }
  return inside;
}

/** Rasterize one stroke band at `scale`: scale the polyline + nib, walk + stamp. */
function rasterStroke(path: TemplateStrokePath, scale: number): DesignCell[] {
  const pts: Vec2[] = path.points.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  if (path.closed && pts.length > 1) pts.push({ ...pts[0] });
  const radius = Math.max(MIN_RADIUS, path.radius * scale);
  return rasterizeStroke(pts, radius, DAB_SPACING, path.color);
}

/** Rasterize one even-odd region at `scale`: scanline the ring bbox, test each cell. */
function rasterFill(path: TemplateFillPath, scale: number): DesignCell[] {
  const rings: Vec2[][] = path.rings.map((ring) =>
    ring.map((p) => ({ x: p.x * scale, y: p.y * scale })),
  );
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const out: DesignCell[] = [];
  if (!isFinite(minX)) return out;
  const x0 = Math.floor(minX);
  const y0 = Math.floor(minY);
  const x1 = Math.ceil(maxX);
  const y1 = Math.ceil(maxY);
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      if (inRings(gx + 0.5, gy + 0.5, rings)) {
        out.push({ dx: gx, dy: gy, color: path.color });
      }
    }
  }
  return out;
}

/**
 * Flatten a template to integer cells at `scale` (unit→cell multiplier), normalized
 * so the top-left cell is `(0, 0)`. Paths rasterize in reveal order; cells are deduped
 * by position (keeping the first hit) UNLESS `tpl.dedupe === false`, which preserves
 * intentional overpaint (the flag's field-then-star) as separate co-signed moves.
 */
export function rasterizeTemplate(
  tpl: StrokeTemplate,
  scale: number,
): RasterizedTemplate {
  const raw: DesignCell[] = [];
  for (const path of tpl.paths) {
    const cells =
      path.kind === "stroke" ? rasterStroke(path, scale) : rasterFill(path, scale);
    for (const c of cells) raw.push(c);
  }

  const dedupe = tpl.dedupe !== false;
  const seen = dedupe ? new Set<string>() : null;
  const kept: DesignCell[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of raw) {
    if (seen) {
      const k = `${c.dx},${c.dy}`;
      if (seen.has(k)) continue;
      seen.add(k);
    }
    kept.push(c);
    if (c.dx < minX) minX = c.dx;
    if (c.dy < minY) minY = c.dy;
    if (c.dx > maxX) maxX = c.dx;
    if (c.dy > maxY) maxY = c.dy;
  }
  if (!isFinite(minX)) return { cells: [], width: 0, height: 0 };

  const cells = kept.map((c) => ({
    dx: c.dx - minX,
    dy: c.dy - minY,
    color: c.color,
  }));
  return { cells, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Exact number of cells a stamp co-signs at `scale` — the visible burst guard. */
export function estimateMoves(tpl: StrokeTemplate, scale: number): number {
  return rasterizeTemplate(tpl, scale).cells.length;
}

/** Scale that fits a template's unit box inside `maxW × maxH` cells (aspect-preserving). */
export function fitScale(
  aspect: { w: number; h: number },
  maxW: number,
  maxH: number,
): number {
  return Math.min(maxW / aspect.w, maxH / aspect.h);
}
