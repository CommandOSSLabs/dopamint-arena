/**
 * A tiny built-in stroke font (A–Z, 0–9, space) so the `text` template stays fully
 * data-driven — no font file, no image asset. Each glyph is a set of polylines on a
 * 4-wide × 6-tall unit grid (y grows downward, baseline at y = 6). {@link buildText}
 * lays glyphs left to right and emits a {@link StrokeTemplate}; the round-nib
 * rasterizer turns those polylines into the same co-signed cells as any other paint.
 */
import type { Vec2 } from "../geometry";
import type { StrokeTemplate, TemplatePath } from "./types";

/** Glyph cell box (unit coords). */
const GLYPH_W = 4;
const GLYPH_H = 6;
/** Horizontal gap between glyphs, and the advance for a space. */
const GLYPH_GAP = 1.6;
const SPACE_ADVANCE = 2.6;
/** Default nib half-width (unit coords) — a legible stick weight. */
const STROKE_RADIUS = 0.5;

/** char → strokes; each stroke a polyline of `[x, y]` points on the 4×6 grid. */
const GLYPHS: Record<string, number[][][]> = {
  A: [[[0, 6], [2, 0], [4, 6]], [[0.9, 4], [3.1, 4]]],
  B: [
    [[0, 0], [0, 6]],
    [[0, 0], [2.6, 0], [3.6, 1], [2.6, 3], [0, 3]],
    [[0, 3], [2.9, 3], [4, 4.3], [2.8, 6], [0, 6]],
  ],
  C: [[[4, 1.2], [3, 0], [1, 0], [0, 1.5], [0, 4.5], [1, 6], [3, 6], [4, 4.8]]],
  D: [[[0, 0], [0, 6]], [[0, 0], [2.5, 0], [4, 2], [4, 4], [2.5, 6], [0, 6]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]],
  G: [
    [[4, 1.2], [3, 0], [1, 0], [0, 1.5], [0, 4.5], [1, 6], [3, 6], [4, 5], [4, 3.4], [2.4, 3.4]],
  ],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[1, 0], [3, 0]], [[2, 0], [2, 6]], [[1, 6], [3, 6]]],
  J: [[[3, 0], [3, 4.6], [2, 6], [0.6, 5.2]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 3.2], [4, 6]]],
  L: [[[0, 0], [0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  O: [[[1, 0], [3, 0], [4, 1.5], [4, 4.5], [3, 6], [1, 6], [0, 4.5], [0, 1.5], [1, 0]]],
  P: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2.4], [3, 3.4], [0, 3.4]]],
  Q: [
    [[1, 0], [3, 0], [4, 1.5], [4, 4.5], [3, 6], [1, 6], [0, 4.5], [0, 1.5], [1, 0]],
    [[2.4, 4.4], [4, 6.2]],
  ],
  R: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2.4], [3, 3.4], [0, 3.4]], [[1.6, 3.4], [4, 6]]],
  S: [
    [[4, 1.2], [3, 0], [1, 0], [0, 1.2], [0, 2.4], [1, 3], [3, 3], [4, 3.8], [4, 4.9], [3, 6], [1, 6], [0, 4.9]],
  ],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 4.5], [1, 6], [3, 6], [4, 4.5], [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [1, 6], [2, 3], [3, 6], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
  Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
  "0": [[[1, 0], [3, 0], [4, 1.5], [4, 4.5], [3, 6], [1, 6], [0, 4.5], [0, 1.5], [1, 0]]],
  "1": [[[1, 1.4], [2, 0], [2, 6]], [[0.6, 6], [3.4, 6]]],
  "2": [[[0, 1.4], [1, 0], [3, 0], [4, 1.4], [4, 2.4], [0, 6], [4, 6]]],
  "3": [
    [[0, 0], [3, 0], [4, 1.2], [3, 2.8], [1.6, 2.8]],
    [[3, 2.8], [4, 3.4], [4, 4.8], [3, 6], [1, 6], [0, 4.8]],
  ],
  "4": [[[3, 6], [3, 0], [0, 3.8], [4, 3.8]]],
  "5": [[[4, 0], [0, 0], [0, 2.8], [3, 2.8], [4, 3.8], [4, 4.9], [3, 6], [1, 6], [0, 4.9]]],
  "6": [
    [[4, 1.2], [3, 0], [1, 0], [0, 1.8], [0, 4.6], [1, 6], [3, 6], [4, 4.8], [4, 3.8], [3, 3], [1, 3], [0, 3.8]],
  ],
  "7": [[[0, 0], [4, 0], [1.6, 6]]],
  "8": [
    [[1.4, 3], [0, 1.8], [0, 1], [1, 0], [3, 0], [4, 1], [4, 1.8], [2.6, 3], [1.4, 3]],
    [[2.6, 3], [4, 4.2], [4, 5], [3, 6], [1, 6], [0, 5], [0, 4.2], [1.4, 3]],
  ],
  "9": [
    [[0, 4.8], [1, 6], [3, 6], [4, 4.2], [4, 1.4], [3, 0], [1, 0], [0, 1.2], [0, 2.2], [1, 3], [3, 3], [4, 2.2]],
  ],
};

/**
 * Build a stroke template that spells `str` (uppercased; unknown chars skipped) in
 * palette `color`. Glyphs are 4×6 unit cells laid left to right; the returned template
 * has `aspect = { w: totalWidth, h: 6 }` so placement scales it like any other.
 */
export function buildText(
  str: string,
  color: number,
  id = "text",
  name = `Text "${str}"`,
): StrokeTemplate {
  const paths: TemplatePath[] = [];
  let cursor = 0;
  for (const ch of str.toUpperCase()) {
    if (ch === " ") {
      cursor += SPACE_ADVANCE;
      continue;
    }
    const strokes = GLYPHS[ch];
    if (!strokes) {
      cursor += GLYPH_W + GLYPH_GAP;
      continue;
    }
    for (const stroke of strokes) {
      const points: Vec2[] = stroke.map(([x, y]) => ({ x: x + cursor, y }));
      paths.push({ kind: "stroke", color, points, radius: STROKE_RADIUS });
    }
    cursor += GLYPH_W + GLYPH_GAP;
  }
  const width = Math.max(GLYPH_W, cursor - GLYPH_GAP);
  return { id, name, category: "text", aspect: { w: width, h: GLYPH_H }, paths };
}
