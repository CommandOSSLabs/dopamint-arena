/**
 * Design-bot target bitmaps. A `PixelDesign` is a small bitmap of palette
 * indices (0 = transparent / don't-care, 1..16 = a color from
 * frontend/src/games/pixelPaint/palette.ts) that a design-bot paints toward, so
 * auto-mode produces recognizable pixel art instead of noise.
 *
 * Pure TypeScript — no React, no assets — so it stays inside the agent import
 * boundary (see frontend/src/agent/.eslintrc-import-boundary.json).
 */

export interface PixelDesign {
  readonly name: string;
  readonly w: number;
  readonly h: number;
  /** length w*h, row-major. 0 = don't-care, 1..16 = palette color index. */
  readonly pixels: ReadonlyArray<number>;
}

/** Build a design from a char grid + legend. "." = don't-care. */
function grid(
  name: string,
  legend: Record<string, number>,
  rows: string[],
): PixelDesign {
  const h = rows.length;
  const w = rows[0].length;
  const pixels: number[] = [];
  for (const row of rows) {
    for (const ch of row) pixels.push(ch === "." ? 0 : (legend[ch] ?? 0));
  }
  return { name, w, h, pixels };
}

export const DESIGNS = {
  // Sui droplet: B = Sui blue (palette 14), w = white highlight (palette 1)
  suiDroplet: grid("Sui droplet", { B: 14, w: 1 }, [
    ".....BB.....",
    "....BBBB....",
    "...BBBBBB...",
    "..BBBBBBBB..",
    ".BBBBBBBBBB.",
    ".BBBwBBBBBB.",
    "BBBBwwBBBBBB",
    "BBBBwBBBBBBB",
    ".BBBBBBBBBB.",
    "..BBBBBBBB..",
    "...BBBBBB...",
    ".....BB.....",
  ]),
  heart: grid("Heart", { R: 6 }, [
    ".RR...RR.",
    "RRRR.RRRR",
    "RRRRRRRRR",
    "RRRRRRRRR",
    ".RRRRRRR.",
    "..RRRRR..",
    "...RRR...",
    "....R....",
  ]),
  smiley: grid("Smiley", { Y: 9, K: 4 }, [
    "..YYYYYY..",
    ".YYYYYYYY.",
    "YYKYYYYKYY",
    "YYKYYYYKYY",
    "YYYYYYYYYY",
    "YYKYYYYKYY",
    "YYKKKKKKYY",
    "YYYKKKKYYY",
    ".YYYYYYYY.",
    "..YYYYYY..",
  ]),
  // Walrus (Sui's storage mascot): w = brown body (8), K = eyes (4),
  // T = white tusks (1).
  walrus: grid("Walrus", { w: 8, K: 4, T: 1 }, [
    "....wwwwwwww....",
    "..wwwwwwwwwwww..",
    ".wwwwwwwwwwwwww.",
    ".wwwwwwwwwwwwww.",
    ".wwKwwwwwwwwKww.",
    ".wwwwwwwwwwwwww.",
    ".wwwwwwwwwwwwww.",
    "..wwwwwwwwwwww..",
    "..wwwTwwwwTwww..",
    "...wwTwwwwTww...",
    ".....TwwwwT.....",
    ".....T....T.....",
  ]),
} as const;

/**
 * Project a design onto a width×height canvas, centered on a fractional anchor
 * (0..1). `anchorX=0.5, anchorY=0.5` is dead-center; give two bots different
 * anchors (e.g. 0.3 vs 0.7) so their designs don't overlap. Returns a Uint8Array
 * where 0 = "don't-care" and 1..16 = the target color.
 */
export function projectDesignAt(
  d: PixelDesign,
  width: number,
  height: number,
  anchorX = 0.5,
  anchorY = 0.5,
): Uint8Array {
  const out = new Uint8Array(width * height); // all 0 = don't-care
  const ox = Math.round(anchorX * (width - 1)) - Math.floor(d.w / 2);
  const oy = Math.round(anchorY * (height - 1)) - Math.floor(d.h / 2);
  for (let ty = 0; ty < d.h; ty++) {
    const y = oy + ty;
    if (y < 0 || y >= height) continue;
    for (let tx = 0; tx < d.w; tx++) {
      const x = ox + tx;
      if (x < 0 || x >= width) continue;
      const c = d.pixels[ty * d.w + tx];
      if (c !== 0) out[y * width + x] = c;
    }
  }
  return out;
}

/** Center a design on the canvas (the default anchor). */
export function projectDesign(
  d: PixelDesign,
  width: number,
  height: number,
): Uint8Array {
  return projectDesignAt(d, width, height, 0.5, 0.5);
}
