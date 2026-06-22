/**
 * Visual tokens + interaction constants for the Pixel Duel UI — a clone of the
 * NIANEZ pixel-war look (deep-navy glass panels, palette dock, cooldown ring)
 * retuned to Dopamint's Sui-blue accent. UI-side only; may import anything.
 */
export const DUEL = {
  bg: "#06060c", // deep navy board void
  board: "#0c1f38", // empty-cell color (matches palette EMPTY_HEX)
  panel: "rgba(18,16,40,0.62)", // glass fill
  panelBorder: "rgba(160,140,255,0.22)", // glass border
  blur: "blur(14px)",
  accent: "#4DA2FF", // Sui blue
  accentSoft: "rgba(77,162,255,0.18)",
  seatA: "#4DA2FF", // territory tint for party A
  seatB: "#CF6EE4", // territory tint for party B
  hit: "#ff3b3b", // landed-attack (blocked) border — a vivid red strike marker
  hitTint: "rgba(255,59,59,0.34)", // subtle red wash over a blocked (hit) cell
  cyan: "#22d3ee", // cooldown-ring glow (kept from NIANEZ)
  text: "#e8e8f0",
  muted: "#8a8aa6",
  grid: "rgba(77,162,255,0.10)",
} as const;

/** Glass-panel inline style shared by every floating panel. */
export const glass = {
  background: DUEL.panel,
  border: `1px solid ${DUEL.panelBorder}`,
  backdropFilter: DUEL.blur,
  WebkitBackdropFilter: DUEL.blur,
  boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
} as const;

export const ZOOM = { min: 1.5, max: 32, step: 1.15 } as const;
export const TAP_SLOP = 6; // px of movement still counted as a tap (not a drag)
export const COOLDOWN_MS = 1500; // wplace/NIANEZ-style place cooldown
