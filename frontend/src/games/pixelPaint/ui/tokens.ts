/**
 * Visual tokens + interaction constants for the Pixel Duel UI — a cosmic
 * liquid-glass restyle (deep space-black void, refracted glass panels, Sui-blue
 * vs orchid seats) matching docs/pixel-duel-design. UI-side only; may import
 * anything. The full liquid-glass panel (refraction + hairline border) lives in
 * the `.pd-glass` class injected by <DuelChrome/>; `glass` here is the inline
 * approximation for elements that can't take a className. Keep export NAMES/shape
 * stable — other files import DUEL, glass, ZOOM, TAP_SLOP, COOLDOWN_MS.
 */
export const DUEL = {
  bg: "#06060c", // deep space-black board void
  board: "#0c1f38", // empty-cell color (matches palette EMPTY_HEX)
  panel: "linear-gradient(140deg, rgba(64,80,130,0.40), rgba(16,18,40,0.24))", // liquid-glass fill
  panelBorder: "rgba(255,255,255,0.16)", // frosted glass edge
  blur: "url(#pdGlass) blur(8px) saturate(180%) brightness(1.08)", // refraction filter (needs <DuelChrome/>)
  accent: "#4DA2FF", // Sui blue
  accentSoft: "rgba(77,162,255,0.18)",
  seatA: "#4DA2FF", // territory tint for party A
  seatB: "#CF6EE4", // territory tint for party B (orchid)
  probe: "#5f6b87", // neutral slate for a revealed probe/attack cell
  hit: "#ff3b3b", // landed-attack (blocked) border — a vivid red strike marker
  hitTint: "rgba(255,59,59,0.34)", // subtle red wash over a blocked (hit) cell
  cyan: "#22d3ee", // cooldown-ring glow
  text: "#e8e8f0",
  muted: "#8a8aa6",
  grid: "rgba(77,162,255,0.10)",
} as const;

/** Type face stacks — load via the @import in <DuelChrome/>. */
export const FONT_DISPLAY = "'Space Grotesk', system-ui, sans-serif" as const;
export const FONT_MONO = "'JetBrains Mono', monospace" as const;

/**
 * Inline liquid-glass style for floating panels that can't take the `.pd-glass`
 * className. Mirrors that class (minus the ::before gradient hairline, which
 * needs a real pseudo-element). Prefer `className="pd-glass"` where possible.
 */
export const glass = {
  background: DUEL.panel,
  border: `1px solid ${DUEL.panelBorder}`,
  backdropFilter: DUEL.blur,
  WebkitBackdropFilter: "blur(12px) saturate(180%)",
  boxShadow:
    "0 14px 46px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -14px 34px rgba(90,140,255,0.07)",
} as const;

export const ZOOM = { min: 1.5, max: 32, step: 1.15 } as const;
export const TAP_SLOP = 6; // px of movement still counted as a tap (not a drag)
export const COOLDOWN_MS = 1500; // wplace/NIANEZ-style place cooldown
