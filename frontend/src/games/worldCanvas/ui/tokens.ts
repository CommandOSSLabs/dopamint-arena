/**
 * Visual tokens + the 16-color paint palette for "The World is Your Canvas".
 *
 * Lean Excalidraw-style redesign: a clean light floating toolbar over the dark
 * cosmic canvas void. The cosmic-dark {@link WC} tokens style the wall + HUD; the
 * toolbar/swatches use plain light surfaces. Keep export NAMES/shape stable —
 * WC is imported by the engine and the canvas; PALETTE/PALETTE_RGB feed the raster.
 */

/** Cells per chunk edge — MUST match the WorldCanvasProtocol / the hook. */
export const CHUNK_SIZE = 256;

export const WC = {
  bg: "#06060c", // deep space-black backdrop behind the wall
  board: "#0b1430", // the empty (unpainted) canvas void — dark navy
  panelBorder: "rgba(255,255,255,0.14)",
  accent: "#4DA2FF", // Sui blue
  seatA: "#4DA2FF", // human (party A) tint — consumed by the engine for agent colors
  seatB: "#CF6EE4", // agent (party B) tint
  text: "#e8e8f0",
  muted: "#8a93ad",
} as const;

export const FONT_DISPLAY = "'Outfit', system-ui, sans-serif" as const;
export const FONT_MONO = "'JetBrains Mono', ui-monospace, monospace" as const;

export const ZOOM = { min: 1, max: 40, step: 1.15 } as const;
/** px of pointer travel still counted as a tap (place) rather than a drag (pan). */
export const TAP_SLOP = 6;

/**
 * Truncate a 0x-hex address to the `4af3…9c21` short form (the "owner EThL…KwRE"
 * cell label). Returns the input unchanged if too short.
 */
export function shortAddress(addr: string): string {
  const hex = addr.startsWith("0x") ? addr.slice(2) : addr;
  if (hex.length <= 8) return addr;
  return `${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

/**
 * The paintable palette. A protocol paint's `color` is a direct index into this
 * array (`[0, 16)`) — there is no "empty" index here; an unpainted cell is the
 * board void, not a palette color. An r/place-style 16-color set with Sui blue.
 */
export const PALETTE: readonly string[] = [
  "#FFFFFF", // 0  white
  "#E4E4E4", // 1  light gray
  "#888888", // 2  gray
  "#222222", // 3  near-black
  "#FFA7D1", // 4  pink
  "#E50000", // 5  red
  "#E59500", // 6  orange
  "#A06A42", // 7  brown
  "#E5D900", // 8  yellow
  "#94E044", // 9  light green
  "#02BE01", // 10 green
  "#00D3DD", // 11 cyan
  "#0083C7", // 12 blue
  "#4DA2FF", // 13 Sui blue
  "#820080", // 14 purple
  "#CF6EE4", // 15 light purple
];

/** Palette pre-parsed to [r,g,b] triples for fast ImageData writes. */
export const PALETTE_RGB: ReadonlyArray<readonly [number, number, number]> =
  PALETTE.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff] as const;
  });
