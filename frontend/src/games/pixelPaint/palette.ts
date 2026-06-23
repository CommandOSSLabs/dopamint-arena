/**
 * Display palette for Pixel Paint. The protocol stores a cell as a color index
 * (0 = empty, 1..NUM_COLORS = a color); this maps each index to a hex for the
 * canvas. An r/place-style 16-color set with Sui blue in the mix.
 */

/** Hex for empty (unpainted) cells — the dark "wall" background. */
export const EMPTY_HEX = "#0c1f38";

/** Colors for indices 1..16 (index 0 is empty and not in this list). */
export const PALETTE: readonly string[] = [
  "#FFFFFF", // 1  white
  "#E4E4E4", // 2  light gray
  "#888888", // 3  gray
  "#222222", // 4  near-black
  "#FFA7D1", // 5  pink
  "#E50000", // 6  red
  "#E59500", // 7  orange
  "#A06A42", // 8  brown
  "#E5D900", // 9  yellow
  "#94E044", // 10 light green
  "#02BE01", // 11 green
  "#00D3DD", // 12 cyan
  "#0083C7", // 13 blue
  "#4DA2FF", // 14 Sui blue
  "#820080", // 15 purple
  "#CF6EE4", // 16 light purple
];

/** Hex for a color index (0 = empty). */
export function colorHex(index: number): string {
  return index === 0 ? EMPTY_HEX : (PALETTE[index - 1] ?? EMPTY_HEX);
}
