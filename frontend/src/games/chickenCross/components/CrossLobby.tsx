import { useState } from "react";
import { SketchDefs } from "../../sketch";
import { CROSS_BTN, CROSS_STYLE } from "../crossTheme";
import { CrossChicken } from "./crossSprites";
import "../cross.css";

/** Splash — centered vertical card (road-crossing vibe). */
export function CrossLobby({
  onSolo,
  onFind,
}: {
  onSolo: (stake: number) => void;
  onFind: () => void;
}) {
  const [tab, setTab] = useState<"solo" | "pvp">("solo");
  const [stake, setStake] = useState("500");

  const handleSolo = () => onSolo(Math.max(1, Math.floor(Number(stake)) || 0));

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
          <p className="cross-lobby__tagline sketch-note">
            hop the lanes — stake &amp; go
          </p>
        </div>

        <div
          className="cross-seg sketch-stroke"
          role="tablist"
          aria-label="Game mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "solo"}
            className={`cross-seg__btn${tab === "solo" ? " cross-seg__btn--on" : ""}`}
            onClick={() => setTab("solo")}
          >
            Solo
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pvp"}
            className={`cross-seg__btn${tab === "pvp" ? " cross-seg__btn--on" : ""}`}
            onClick={() => setTab("pvp")}
          >
            PvP
          </button>
        </div>

        {tab === "solo" ? (
          <div className="cross-lobby__stake">
            <span className="sketch-eyebrow">Stake</span>
            <div className="sketch-action-join">
              <label className="sketch-field sketch-field--join-left">
                <input
                  className="sketch-field__control"
                  type="number"
                  min={1}
                  aria-label="Stake"
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                />
              </label>
              <button
                type="button"
                className={`${CROSS_BTN} cross-cta cross-cta--join sketch-btn sketch-btn--go sketch-btn--join-right`}
                onClick={handleSolo}
              >
                Go
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={`${CROSS_BTN} cross-cta cross-cta--full sketch-btn sketch-btn--go`}
            onClick={onFind}
          >
            Find match
          </button>
        )}
      </div>
    </div>
  );
}
