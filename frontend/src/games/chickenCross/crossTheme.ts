import type { CSSProperties } from "react";

/** Crossy Road–inspired palette — bright, flat, no WebGL. */
export const CROSS_STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--cx-sky-top": "#7ec8e8",
  "--cx-sky-mid": "#5eb5e0",
  "--cx-sky-bot": "#4aa8d8",
  "--cx-grass": "#8bc34a",
  "--cx-grass-dark": "#689f38",
  "--cx-dirt": "#e8a735",
  "--cx-dirt-dark": "#c8871f",
  "--cx-road": "#5c5c5c",
  "--cx-road-dark": "#454545",
  "--cx-lane-mark": "#f5f5f5",
  "--cx-water": "#29b6f6",
  "--cx-water-dark": "#039be5",
  "--cx-rail-tie": "#8d6e63",
  "--cx-rail-metal": "#b0bec5",
  "--cx-tree": "#43a047",
  "--cx-tree-dark": "#2e7d32",
  "--cx-trunk": "#795548",
  "--cx-chicken": "#fafafa",
  "--cx-comb": "#e53935",
  "--cx-beak": "#ffb300",
  "--cx-shadow": "rgba(0, 0, 0, 0.22)",
  "--cx-hud-ink": "#ff8f00",
  "--cx-hud-outline": "#3e2723",
  "--cx-car-red": "#e53935",
  "--cx-car-blue": "#1e88e5",
  "--cx-car-yellow": "#fdd835",
  "--cx-car-purple": "#8e24aa",
  "--cx-car-orange": "#fb8c00",
  "--cx-log": "#6d4c41",
  "--cx-log-dark": "#4e342e",
  "--cx-train": "#37474f",
  "--cx-train-accent": "#ffc107",
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
