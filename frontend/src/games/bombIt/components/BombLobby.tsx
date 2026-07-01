import { SketchDefs } from "../../sketch";
import "../bomb-it.css";
import { BOMB_BTN, BOMB_IT_STYLE } from "../bombItTheme";
import { BombGlyph, BombLobbyScene } from "./bombSprites";

/** Splash — arena scene + a single Play button that joins the relay queue. */
export function BombLobby({ onPlay }: { onPlay: () => void }) {
  return (
    <div style={BOMB_IT_STYLE} className="bomb-lobby sketch">
      <SketchDefs />
      <BombLobbyScene />
      <div className="bomb-lobby__deck sketch-stroke sketch-panel">
        <header className="bomb-lobby__deck-head">
          <span className="bomb-lobby__mascot" aria-hidden>
            <BombGlyph kind="bomb" size="sm" pulse />
          </span>
          <h2 className="bomb-lobby__title sketch-title">Bomb It</h2>
        </header>

        <button
          type="button"
          className={`${BOMB_BTN} bomb-cta bomb-cta--full sketch-btn sketch-btn--go`}
          onClick={onPlay}
        >
          Play
        </button>
      </div>
    </div>
  );
}
