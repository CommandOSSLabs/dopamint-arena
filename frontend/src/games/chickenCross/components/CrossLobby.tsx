import { SketchDefs } from "../../sketch";
import "../cross.css";
import { CROSS_BTN, CROSS_STYLE } from "../crossTheme";
import { CrossChicken } from "./crossSprites";

/** Splash — centered vertical card with a single Play button that joins the relay queue. */
export function CrossLobby({ onPlay }: { onPlay: () => void }) {
  return (
    <div className="cross-lobby sketch" style={CROSS_STYLE}>
      <SketchDefs />
      <div className="cross-lobby__card cross-lobby__card--welcome sketch-stroke sketch-panel">
        <div className="cross-lobby__hero">
          <span
            className="cross-lobby__mascot cross-lobby__mascot--lg"
            aria-hidden
          >
            <CrossChicken party="a" mini />
          </span>
          <h2 className="cross-lobby__title sketch-title">Chicken Cross</h2>
          <p className="cross-lobby__tagline sketch-note">hop the lanes</p>
        </div>

        <button
          type="button"
          className={`${CROSS_BTN} cross-cta cross-cta--full sketch-btn sketch-btn--go`}
          onClick={onPlay}
        >
          Play
        </button>
      </div>
    </div>
  );
}
