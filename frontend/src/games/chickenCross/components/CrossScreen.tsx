import type { ReactNode } from "react";
import { CROSS_BTN, CROSS_STYLE } from "../crossTheme";
import "../cross.css";

/** Transitional screen (funding / matching / error). */
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
    <div className="cross-lobby" style={CROSS_STYLE}>
      <div className="cross-lobby__card cross-lobby__card--compact">
        {children}
        {onBack && (
          <button type="button" className={`${CROSS_BTN} cross-cta cross-cta--full cross-cta--ghost`} onClick={onBack}>
            {backLabel}
          </button>
        )}
      </div>
    </div>
  );
}
