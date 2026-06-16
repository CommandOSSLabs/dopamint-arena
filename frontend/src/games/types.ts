import type { ComponentType } from "react";

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
  /** Short glyph/emoji shown in the catalog and taskbar. */
  icon: string;
  Window: ComponentType<GameWindowProps>;
  // Deferred until games drive the engine:
  //   protocolFactory?: () => Protocol<unknown, unknown>;  // from sui-tunnel-ts
}
