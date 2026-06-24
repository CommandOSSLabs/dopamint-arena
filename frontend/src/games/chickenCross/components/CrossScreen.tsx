import type { ReactNode } from "react";
import { SketchDefs } from "../../sketch";
import { CROSS_BTN, CROSS_STYLE } from "../crossTheme";
import "../cross.css";

/** Transitional screen (funding / matching / error) — compact cross card. */
export function CrossScreen({
  children,
  onBack,
  backLabel = "Back",
}: {
  children: ReactNode;
  onBack?: () => void;
  backLabel?: string;
}) {
  return (
    <div className="cross-lobby sketch" style={CROSS_STYLE}>
      <SketchDefs />
      <div className="cross-lobby__card cross-lobby__card--compact sketch-stroke sketch-panel">
        {children}
        {onBack && (
          <button
            type="button"
            className={`${CROSS_BTN} cross-cta cross-cta--full sketch-btn sketch-btn--ghost`}
            onClick={onBack}
          >
            {backLabel}
          </button>
        )}
      </div>
    </div>
  );
}
