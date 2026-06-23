/**
 * Visual tokens + the 16-color paint palette for "The World is Your Canvas".
 *
 * Self-contained (the pixel-duel UI lives on another branch): a cosmic dark
 * arena look — deep space-black void, Sui-blue accent, frosted-glass floating
 * panels — adapted to a wplace/nianez-style collaborative pixel wall. Fonts are
 * the arena globals (Outfit + JetBrains Mono, loaded in styles/index.css), so no
 * font injection is needed. Keep export NAMES/shape stable: other UI files
 * import WC, glass, PALETTE, PALETTE_RGB, ZOOM, TAP_SLOP.
 */

import type { CSSProperties } from "react";

/** Cells per chunk edge — MUST match the WorldCanvasProtocol / the hook. */
export const CHUNK_SIZE = 256;

export const WC = {
  bg: "#06060c", // deep space-black backdrop behind the wall
  board: "#0b1430", // the empty (unpainted) canvas void — dark navy
  panel: "linear-gradient(140deg, rgba(64,80,130,0.34), rgba(16,18,40,0.30))",
  panelBorder: "rgba(255,255,255,0.14)",
  accent: "#4DA2FF", // Sui blue
  accentSoft: "rgba(77,162,255,0.16)",
  seatA: "#4DA2FF", // human (party A) tint
  seatB: "#CF6EE4", // agent (party B) tint
  ok: "#5fe3a1", // on-chain / ready green
  warn: "#f2c94c", // opening / demo amber
  err: "#ff5a6a",
  text: "#e8e8f0",
  muted: "#8a93ad",
  grid: "rgba(120,160,255,0.12)",
} as const;

export const FONT_DISPLAY = "'Outfit', system-ui, sans-serif" as const;
export const FONT_MONO = "'JetBrains Mono', ui-monospace, monospace" as const;

/** Inline frosted-glass style for floating HUD panels. */
export const glass = {
  background: WC.panel,
  border: `1px solid ${WC.panelBorder}`,
  backdropFilter: "blur(12px) saturate(160%)",
  WebkitBackdropFilter: "blur(12px) saturate(160%)",
  boxShadow:
    "0 14px 40px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.22)",
} as const;

export const ZOOM = { min: 1, max: 40, step: 1.15 } as const;
/** px of pointer travel still counted as a tap (place) rather than a drag (pan). */
export const TAP_SLOP = 6;

/**
 * Compact segmented-control pill for the agent Speed / Intelligence selectors, in
 * the world-canvas glass look. `tint` colors the ACTIVE state — accent for Speed,
 * seatB for the drawing mode — so the two selector groups read as distinct.
 */
export function agentPill(
  active: boolean,
  tint: string = WC.accent,
): CSSProperties {
  return {
    cursor: "pointer",
    border: active ? `1px solid ${tint}` : "1px solid rgba(255,255,255,0.12)",
    background: active ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.03)",
    color: active ? WC.text : WC.muted,
    boxShadow: active ? `inset 0 0 0 1px ${tint}` : "none",
    borderRadius: 8,
    padding: "4px 8px",
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1,
    fontFamily: FONT_DISPLAY,
    transition: "background .12s, color .12s, border-color .12s",
  };
}

/**
 * Truncate a 0x-hex address to the `4af3…9c21` short form (mirrors the wplace /
 * nianez "owner EThL…KwRE" label). Returns the input unchanged if too short.
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
