import type { CSSProperties } from "react";

/** Crossy Road lanes on Quantum Poker sketch paper — muted washes only. */
export const CROSS_STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--cx-sky-top": "#fbf9f3",
  "--cx-sky-mid": "#fbf9f3",
  "--cx-sky-bot": "#fbf9f3",
  "--cx-grass": "#d4f0d8",
  "--cx-grass-dark": "#c2e8c8",
  "--cx-dirt": "#f0e8d4",
  "--cx-dirt-dark": "#e8deca",
  "--cx-road": "#eceae4",
  "--cx-road-dark": "#e3e0d8",
  "--cx-lane-mark": "rgba(35, 34, 31, 0.35)",
  "--cx-water": "#c8e4f8",
  "--cx-water-dark": "#b8daf5",
  "--cx-rail-tie": "#f5efe8",
  "--cx-rail-metal": "#d8dee4",
  "--cx-tree": "#b8e6bc",
  "--cx-tree-dark": "#a8ddb2",
  "--cx-trunk": "#e8ddd0",
  "--cx-chicken": "#fffefb",
  "--cx-comb": "#e03131",
  "--cx-beak": "#e8920c",
  "--cx-shadow": "rgba(35, 34, 31, 0.12)",
  "--cx-hud-ink": "#e8920c",
  "--cx-hud-outline": "#23221f",
  "--cx-car-red": "#f5b8b8",
  "--cx-car-blue": "#a8c8f0",
  "--cx-car-yellow": "#f5e6a8",
  "--cx-car-purple": "#d4b8f0",
  "--cx-car-orange": "#f5c898",
  "--cx-log": "#ede4d8",
  "--cx-log-dark": "#e4d9cb",
  "--cx-train": "#e8ecef",
  "--cx-train-accent": "#ffe9bd",
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

export const CROSS_BTN =
  "rounded-md px-3 py-1.5 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cx-hud-ink)]/40";

/** Deterministic car body color from lane hazard ordinal. */
export const CAR_COLORS = [
  "var(--cx-car-red)",
  "var(--cx-car-blue)",
  "var(--cx-car-yellow)",
  "var(--cx-car-purple)",
  "var(--cx-car-orange)",
] as const;

export function carColor(lane: number, ordinal: number): string {
  return CAR_COLORS[(lane * 3 + ordinal) % CAR_COLORS.length];
}

/** Stable grass-tree placement — decor only, never blocks play. */
export function grassHasTree(seed: number, lane: number, col: number): boolean {
  const h = ((seed * 1103515245 + lane * 7919 + col * 104729) >>> 0) % 997;
  return col !== 4 && h % 11 === 0;
}
