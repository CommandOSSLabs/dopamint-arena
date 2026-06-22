import type { ComponentType } from "react";

/** Props a game's `Window` component receives (distinct from the GameWindow chrome). */
export interface GameWindowProps {
  windowId: string;
  onClose: () => void;
}

/**
 * A pluggable game. Adding one = create a folder under games/, implement a
 * `Window` component, and call `register()` (see games/regularPayments for the
 * reference template). The catalog lists modules and launching renders `Window`
 * inside the desktop window chrome — no edits to Desktop/Catalog/panels needed.
 */
export interface GameModule {
  /** Stable kebab-case id, unique across the registry. */
  id: string;
  name: string;
  /** Short glyph/emoji — fallback when the logo image is unavailable. */
  icon: string;
  /** Logo image path (served from public/, e.g. `/games/blackjack.png`). */
  image: string;
  Window: ComponentType<GameWindowProps>;
  /**
   * Opening size in grid units (default 4×4). Pick a size whose on-screen ratio
   * suits the game — e.g. Battleship's two 10×10 boards want a wider, taller box.
   */
  defaultSize?: { w: number; h: number };
  /** Smallest size the window may resize to, in grid units (default 3×3). */
  minSize?: { w: number; h: number };
  // Deferred until games drive the engine:
  //   protocolFactory?: () => Protocol<unknown, unknown>;  // from sui-tunnel-ts
}
