import type { ReactNode } from "react";
import { SketchDefs } from "../../sketch";
import { BOMB_BTN, BOMB_IT_STYLE } from "../bombItTheme";
import "../bomb-it.css";

/** Transitional screen (funding / matching / error) — compact centered card. */
export function BombScreen({
  children,
  onBack,
  backLabel = "Back",
}: {
  children: ReactNode;
  onBack?: () => void;
  backLabel?: string;
}) {
  return (
    <div style={BOMB_IT_STYLE} className="bomb-lobby sketch">
      <SketchDefs />
      <div className="bomb-lobby__card bomb-lobby__card--compact sketch-stroke sketch-panel">
        {children}
        {onBack && (
          <button
            type="button"
            className={`${BOMB_BTN} bomb-cta bomb-cta--full sketch-btn sketch-btn--ghost`}
            onClick={onBack}
          >
            {backLabel}
          </button>
        )}
      </div>
    </div>
  );
}
