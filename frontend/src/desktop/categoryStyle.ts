import type { Workspace } from "../games/types";

/**
 * Per-category (workspace) identity styling, as Tailwind utilities off the registered `cat-*`
 * theme colors (see the `@theme inline` block in styles/index.css). Those colors are theme-constant,
 * so a solid fill keeps cream-text contrast in both light and dark. Class strings are LITERAL so
 * Tailwind's scanner emits them.
 *
 * Category → color: Game = pink, Payment = mint, Chat = blue (the aurora accent triad).
 */
export interface CategoryStyle {
  label: string;
  /** Solid CONSTANT fill for a selected/active surface; pair with cream text (`text-primary-foreground`). */
  solid: string;
  /** Adaptive accent as text/icon on a neutral surface (reads in both themes). */
  text: string;
  /** Solid adaptive accent for an accent bar/dot. */
  bar: string;
  /** A category wash for a header/tile background (adaptive accent, low opacity). */
  tint: string;
}

export const CATEGORY_STYLE: Record<Workspace, CategoryStyle> = {
  games: {
    label: "Game",
    solid: "bg-cat-game",
    text: "text-cat-game-accent",
    bar: "bg-cat-game-accent",
    tint: "bg-cat-game-accent/10",
  },
  payment: {
    label: "Payment",
    solid: "bg-cat-payment",
    text: "text-cat-payment-accent",
    bar: "bg-cat-payment-accent",
    tint: "bg-cat-payment-accent/10",
  },
  chat: {
    label: "Chat",
    solid: "bg-cat-chat",
    text: "text-cat-chat-accent",
    bar: "bg-cat-chat-accent",
    tint: "bg-cat-chat-accent/10",
  },
};
