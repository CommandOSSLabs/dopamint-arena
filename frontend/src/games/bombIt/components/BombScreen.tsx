import type { ReactNode } from "react";
import { BOMB_BTN, BOMB_IT_STYLE } from "../bombItTheme";
import { BombLobbyScene } from "./bombSprites";
import "../bomb-it.css";

/** Transitional screen (funding / matching / error) on the Bomb It shell. */
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
    <div style={BOMB_IT_STYLE} className="bomb-lobby">
      <BombLobbyScene />
      <div className="bomb-lobby__dock bomb-lobby__dock--status">
        <div className="bomb-lobby__status">
          {children}
          {onBack && (
            <button type="button" className={`${BOMB_BTN} bomb-cta-ghost`} onClick={onBack}>
              {backLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
