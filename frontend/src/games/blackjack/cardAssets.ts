/**
 * Resolve bundled URLs for game-local card art. A card is a display index 0..51
 * (`index = suit*13 + rankIndex`). Vite-only (import.meta.glob) — never import from a test.
 */
const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;
const NAMES = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

const urls = import.meta.glob("./assets/cards/**/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

import cardBack from "./assets/card-back.png";

export function cardUrlFromIndex(cardIndex: number): string {
  const suit = SUITS[Math.floor(cardIndex / 13)];
  const name = NAMES[cardIndex % 13];
  return urls[`./assets/cards/${suit}/${suit}-${name}.svg`];
}

export const cardBackUrl: string = cardBack;
