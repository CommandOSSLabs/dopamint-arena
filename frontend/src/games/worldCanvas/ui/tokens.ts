/**
 * Visual tokens + the 16-color paint palette for "The World is Your Canvas".
 *
 * The chrome (toolbar, control bars, leaderboard, zoom HUD, lobby) is THEME-AWARE:
 * the {@link WC} string tokens point straight at the app's design-system CSS variables
 * (--card / --background / --foreground / --muted-foreground / --primary / --border /
 * --wal-glow), so every panel follows the arena's light/dark toggle — reading
 * LIGHT/native over the white drawing canvas in light mode (card glass becomes
 * white@72%, ink text, dark hairlines) and flipping to dark glass under the dark theme.
 * The paint tints the CANVAS renders (seatA/seatB) and the brand accent stay LITERAL
 * hex, because a 2D-canvas fillStyle/strokeStyle can't resolve a CSS var(). Keep export
 * NAMES/shape stable — WC is imported by the engine and the canvas;
 * PALETTE/PALETTE_RGB feed the raster (16-color r/place set — game content, left as-is).
 */

/** Cells per chunk edge — MUST match the WorldCanvasProtocol / the hook. */
export const CHUNK_SIZE = 256;

export const WC = {
  bg: "var(--background)", // backdrop behind the (always-white) canvas — follows theme
  board: "var(--background)", // unpainted void = app background (the draw canvas itself is white)
  panelBorder: "var(--border)", // theme hairline (dark-on-light in light, light-on-dark in dark)
  // Brand violet (--primary is theme-independent). Literal hex because it doubles as a
  // 2D-canvas stroke (the brush-footprint preview), which can't resolve a CSS var.
  accent: "#613dff",
  seatA: "#613dff", // human (party A) tint — CANVAS stroke color (engine); literal hex
  seatB: "#CF6EE4", // agent (party B) tint — CANVAS stroke color (engine); literal hex
  text: "var(--foreground)", // theme ink (light) / cream (dark)
  muted: "var(--muted-foreground)",
  // Translucent card so chrome frosts over the wall; color-mix keeps it theme-aware —
  // white@72% in light, ink-card@72% in dark, both straight off --card.
  glass: "color-mix(in srgb, var(--card) 72%, transparent)",
  glassBorder: "var(--border)", // theme hairline for the glass edge
  toolbar: "color-mix(in srgb, var(--card) 72%, transparent)", // floating toolbar = same glass
  toolbarBorder: "var(--border)",
  glow: "var(--wal-glow)", // theme-aware drop-glow (soft violet light / vivid dark)
  // Interactive-state tints derived from the theme ink/primary so they invert with the
  // theme: a subtle dark wash on light chrome, a subtle light wash on dark chrome.
  softFill: "color-mix(in srgb, var(--foreground) 6%, transparent)", // hover / ghost-pill bg
  softFillHover: "color-mix(in srgb, var(--foreground) 12%, transparent)", // stronger hover
  accentFill: "color-mix(in srgb, var(--primary) 16%, transparent)", // active tool/brush highlight
  track: "color-mix(in srgb, var(--foreground) 22%, transparent)", // switch off-track
  hairline: "color-mix(in srgb, var(--foreground) 16%, transparent)", // swatch/chip hairline
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

/**
 * The reserved eraser palette index. An erase is a REAL co-signed paint move that crosses
 * the tunnel like any other cell (so it syncs to the opponent), but EVERY painter — local
 * AND received — RENDERS a cell of this index in the canvas backdrop color, so an erase
 * reads as "erased" on both seats' walls. Index 0 (white) is reserved for this: it's the
 * white backdrop, and it's deliberately omitted from the toolbar swatches, so it's never a
 * selectable draw color. PvE and PvP MUST share this index so an erase round-trips cleanly.
 */
export const ERASER_COLOR = 0;

/** Palette pre-parsed to [r,g,b] triples for fast ImageData writes. */
export const PALETTE_RGB: ReadonlyArray<readonly [number, number, number]> =
  PALETTE.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff] as const;
  });
