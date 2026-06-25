import type { CSSProperties, ReactNode } from "react";
import { SketchDefs } from "../sketch";

/** Per-game card chrome for the transitional screens — the only thing that differs between games. */
export interface ArenaScreenTheme {
  /** Root style object seeding the game's CSS custom properties (e.g. BOMB_IT_STYLE). */
  style: CSSProperties;
  /** Root wrapper classes (e.g. "bomb-lobby sketch"). */
  rootClass: string;
  /** Inner card classes (e.g. "bomb-lobby__card bomb-lobby__card--compact sketch-stroke sketch-panel"). */
  cardClass: string;
  /** Back-button classes (the game's CTA + ghost variant). */
  backBtnClass: string;
}

/**
 * Transitional screen (funding / matching / error / loading) — a compact centered card shared by the
 * arena games. The per-game `theme` supplies the card chrome; the content is the caller's children.
 * Replaces the byte-identical per-game `BombScreen` / `CrossScreen`.
 */
export function ArenaScreen({
  theme,
  children,
  onBack,
  backLabel = "Back",
}: {
  theme: ArenaScreenTheme;
  children: ReactNode;
  onBack?: () => void;
  backLabel?: string;
}) {
  return (
    <div style={theme.style} className={theme.rootClass}>
      <SketchDefs />
      <div className={theme.cardClass}>
        {children}
        {onBack && (
          <button type="button" className={theme.backBtnClass} onClick={onBack}>
            {backLabel}
          </button>
        )}
      </div>
    </div>
  );
}
