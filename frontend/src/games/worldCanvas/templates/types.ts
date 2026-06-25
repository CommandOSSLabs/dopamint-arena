/**
 * Vector STAMP TEMPLATE types — resolution-independent line/region art that both a
 * human "stamp" and an Artist-mode agent rasterize into co-signed paint cells.
 *
 * A template is pure float-space geometry in a UNIT box (`aspect`): `stroke` paths
 * are smooth bands (a polyline + a nib radius) and `fill` paths are even-odd regions
 * (one outer ring + optional holes). Placement maps the unit box to world cells at a
 * chosen `scale`; the single float→integer funnel is {@link rasterizeTemplate}, which
 * reuses the agent modes' `rasterizeStroke` + `inPolygon`, so a stamped cell is the
 * SAME frozen integer move as any other paint — no new wire, no Move/SDK change.
 *
 * Colors are pre-quantized to the 16-index palette (ui/tokens.ts PALETTE), so a path's
 * `color` is a direct palette index in `[0, 16)`.
 */
import type { Vec2 } from "../geometry";

/** Grouping for the picker surfaces (Stamp dock + agent template strip). */
export type TemplateCategory = "logo" | "vietnam" | "shape" | "text";

/** A smooth band: walk `points` and stamp a round nib of `radius` (UNIT coords). */
export interface TemplateStrokePath {
  kind: "stroke";
  /** Palette index in `[0, 16)`. */
  color: number;
  /** Polyline in unit coords `[0, aspect.w] × [0, aspect.h]`. */
  points: Vec2[];
  /** Close the band back to its first point (outlines, rings). */
  closed?: boolean;
  /** Nib half-width in UNIT coords; scaled with the template at rasterize time. */
  radius: number;
}

/** An even-odd filled region: `rings[0]` is the outer ring, the rest are holes. */
export interface TemplateFillPath {
  kind: "fill";
  /** Palette index in `[0, 16)`. */
  color: number;
  /** Closed rings in unit coords; inside-ness is the XOR across all rings. */
  rings: Vec2[][];
}

export type TemplatePath = TemplateStrokePath | TemplateFillPath;

/** A registered stamp template. A new template = one entry in the registry. */
export interface StrokeTemplate {
  id: string;
  /** Short label shown under the picker thumbnail. */
  name: string;
  category: TemplateCategory;
  /** Unit box the paths live in; placement maps it to world cells. */
  aspect: { w: number; h: number };
  /** Paths in REVEAL ORDER (fields first, emblem strokes last). */
  paths: TemplatePath[];
  /** Default true. `false` keeps deliberate same-cell overpaint (e.g. the flag's
   *  red field then the gold star over it) as two distinct co-signed moves. */
  dedupe?: boolean;
}

/** A template flattened to integer cells, normalized so `min(dx,dy) = 0`. */
export interface RasterizedTemplate {
  /** Integer cells in reveal order, offsets from the stamp's top-left origin. */
  cells: { dx: number; dy: number; color: number }[];
  /** Footprint width/height in cells (sizes the agent slot / stamp centering). */
  width: number;
  height: number;
}
