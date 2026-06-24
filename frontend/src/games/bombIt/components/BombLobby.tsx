import { useState } from "react";
import { SketchDefs } from "../../sketch";
import { BOMB_BTN, BOMB_IT_STYLE } from "../bombItTheme";
import { BombGlyph, BombLobbyScene } from "./bombSprites";
import "../bomb-it.css";

/** Splash — arena scene + bottom deck with mode tiles. */
export function BombLobby({
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

        <div
          className="bomb-lobby__modes"
          role="tablist"
          aria-label="Game mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "solo"}
            className={`bomb-mode-tile sketch-stroke${tab === "solo" ? " bomb-mode-tile--on" : ""}`}
            onClick={() => setTab("solo")}
          >
            <span className="bomb-mode-tile__art" aria-hidden>
              <BombGlyph kind="crate" size="sm" />
              <BombGlyph kind="bomb" size="sm" pulse />
            </span>
            <span className="bomb-mode-tile__label">Solo</span>
            <span className="bomb-mode-tile__hint sketch-note">vs bots</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pvp"}
            className={`bomb-mode-tile sketch-stroke${tab === "pvp" ? " bomb-mode-tile--on" : ""}`}
            onClick={() => setTab("pvp")}
          >
            <span
              className="bomb-mode-tile__art bomb-mode-tile__art--versus"
              aria-hidden
            >
              <BombGlyph kind="player-a" size="sm" />
              <BombGlyph kind="player-b" size="sm" />
            </span>
            <span className="bomb-mode-tile__label">PvP</span>
            <span className="bomb-mode-tile__hint sketch-note">find match</span>
          </button>
        </div>

        {tab === "solo" ? (
          <div className="bomb-lobby__stake">
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
                className={`${BOMB_BTN} bomb-cta bomb-cta--join sketch-btn sketch-btn--go sketch-btn--join-right`}
                onClick={handleSolo}
              >
                Go
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={`${BOMB_BTN} bomb-cta bomb-cta--full sketch-btn sketch-btn--go`}
            onClick={onFind}
          >
            Find match
          </button>
        )}
      </div>
    </div>
  );
}
