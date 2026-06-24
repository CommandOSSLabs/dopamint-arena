import type { CSSProperties } from "react";

/** Bomb It palette — warm industrial arena, distinct from Chicken Cross highway neon. */
export const BOMB_IT_STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--bi-ink": "#0a090d",
  "--bi-panel": "#141018",
  "--bi-rail": "#1e1a24",
  "--bi-ember": "#f97316",
  "--bi-ember-glow": "rgba(249, 115, 22, 0.45)",
  "--bi-blast": "#ef4444",
  "--bi-cyan": "#22d3ee",
  "--bi-fuchsia": "#e879f9",
  "--bi-gold": "#fbbf24",
  "--bi-muted": "#94a3b8",
};

export const BOMB_BTN =
  "px-2 py-1 text-[10px] font-semibold transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--bi-ember)]/50";
