import type { CSSProperties } from "react";

/** Bomb It palette — sketch paper base (Quantum Poker) + arena accents. */
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
  "--sketch-ink": "#23221f",
  "--sketch-ink-soft": "rgba(35, 34, 31, 0.6)",
  "--sketch-paper": "#fbf9f3",
  "--sketch-fill": "#fffefb",
  "--sketch-accent": "#e8920c",
  "--sketch-accent-fill": "#ffe9bd",
  "--sketch-red": "#e03131",
  "--sketch-red-fill": "#ffe9e9",
  "--sketch-blue": "#1971c2",
  "--sketch-blue-fill": "#e7f1fb",
  "--sketch-violet": "#6741d9",
  "--sketch-felt": "#2f9e44",
  "--sketch-felt-fill": "#eaf8ee",
};

export const BOMB_BTN =
  "px-2 py-1 text-[10px] font-semibold transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--bi-ember)]/50";
