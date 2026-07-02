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
  /** Solid fill for a selected/active surface; pair with cream text (`text-primary-foreground`). */
  solid: string;
  /** Category color as text/icon on a neutral surface. */
  text: string;
  /** A thin accent bar/border in the category color. */
  bar: string;
  /** A faint category wash for a header/tile background. */
  tint: string;
}

export const CATEGORY_STYLE: Record<Workspace, CategoryStyle> = {
  games: {
    label: "Game",
    solid: "bg-cat-game",
    text: "text-cat-game",
    bar: "bg-cat-game",
    tint: "bg-cat-game/8",
  },
  payment: {
    label: "Payment",
    solid: "bg-cat-payment",
    text: "text-cat-payment",
    bar: "bg-cat-payment",
    tint: "bg-cat-payment/8",
  },
  chat: {
    label: "Chat",
    solid: "bg-cat-chat",
    text: "text-cat-chat",
    bar: "bg-cat-chat",
    tint: "bg-cat-chat/8",
  },
};
