/**
 * Visual tokens + the 16-color paint palette for "The World is Your Canvas".
 *
 * The chrome (toolbar, control bars, leaderboard, zoom HUD, lobby) wears the shared
 * hand-drawn `.sketch` skin, so it is THEME-INDEPENDENT: dark ink text on warm paper
 * with wobbly ink borders, regardless of the app's light/dark toggle. The {@link WC}
 * text/line tokens therefore resolve against the sketch ink variables (defined on the
 * `.wc-sketch.sketch` root the chrome lives under) — NOT the app's --foreground/--card,
 * which would flip light text onto the cream paper under the dark theme. The wobble
 * borders + pastel fills come from the `.sketch-stroke` / `.sketch-panel` classes, so
 * the old glass/glow tokens are now inert (transparent / none). The paint tints
 * (seatA/seatB) and the brand accent stay LITERAL hex, because a 2D-canvas
 * fillStyle/strokeStyle can't resolve a CSS var(). Keep export NAMES/shape stable — WC
 * is imported by the engine and the canvas; PALETTE/PALETTE_RGB feed the raster
 * (16-color r/place set — game content, left as-is).
 */

/** Cells per chunk edge — MUST match the WorldCanvasProtocol / the hook. */
export const CHUNK_SIZE = 256;

export const WC = {
  bg: "var(--background)", // solid backdrop the opaque white canvas sits on (theme bg)
  board: "var(--background)", // unpainted void = app background (the draw canvas itself is white)
  panelBorder: "color-mix(in srgb, var(--sketch-ink) 22%, transparent)", // faint ink hairline
  // Brand violet. Literal hex because it doubles as a 2D-canvas stroke (the brush-footprint
  // preview + agent markers), which can't resolve a CSS var.
  accent: "#613dff",
  seatA: "#613dff", // human (party A) tint — CANVAS stroke color (engine); literal hex
  seatB: "#CF6EE4", // agent (party B) tint — CANVAS stroke color (engine); literal hex
  text: "var(--sketch-ink)", // hand-drawn ink — dark on paper, theme-independent
  muted: "var(--sketch-ink-soft)", // softer ink for secondary labels
  // Panels now carry their fill/border via `.sketch-stroke` ::before, so these legacy
  // glass tokens are inert: transparent fills + no border line + no drop-glow.
  glass: "transparent",
  glassBorder: "color-mix(in srgb, var(--sketch-ink) 20%, transparent)", // faint ink dividers
  toolbar: "transparent",
  toolbarBorder: "color-mix(in srgb, var(--sketch-ink) 20%, transparent)",
  glow: "none",
  // Interactive-state tints derived from the sketch ink/accent so they read on the paper.
  softFill: "color-mix(in srgb, var(--sketch-ink) 8%, transparent)", // hover / ghost-pill bg
  softFillHover: "color-mix(in srgb, var(--sketch-ink) 14%, transparent)", // stronger hover
  accentFill: "var(--sketch-accent-fill)", // active tool/brush highlight (light violet)
  track: "color-mix(in srgb, var(--sketch-ink) 22%, transparent)", // switch off-track
  hairline: "color-mix(in srgb, var(--sketch-ink) 22%, transparent)", // swatch/chip hairline
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
