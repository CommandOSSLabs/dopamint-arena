import { useState } from "react";
import { BOMB_BTN, BOMB_IT_STYLE } from "../bombItTheme";
import { BombGlyph, BombLobbyScene } from "./bombSprites";
import "../bomb-it.css";

/** Splash/menu: bottom HUD dock + ambient arena assets (distinct from Chicken Cross card). */
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
    <div style={BOMB_IT_STYLE} className="bomb-lobby">
      <BombLobbyScene />

      <footer className="bomb-lobby__dock">
        <div className="bomb-lobby__brand">
          <h2 className="bomb-lobby__mark wal-doto">
            <span>BOMB</span>
            <span>IT</span>
          </h2>
          <div className="bomb-lobby__legend">
            <BombGlyph kind="player-a" size="sm" />
            <BombGlyph kind="bomb" size="sm" pulse />
            <BombGlyph kind="player-b" size="sm" />
          </div>
        </div>

        <div className="bomb-lobby__console">
          <div className="bomb-lobby__modes" role="tablist" aria-label="Game mode">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "solo"}
              className={`bomb-mode${tab === "solo" ? " bomb-mode--on" : ""}`}
              onClick={() => setTab("solo")}
            >
              <BombGlyph kind="bomb" size="sm" />
              <span>Solo</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "pvp"}
              className={`bomb-mode${tab === "pvp" ? " bomb-mode--on" : ""}`}
              onClick={() => setTab("pvp")}
            >
              <span className="bomb-mode__versus" aria-hidden>
                <BombGlyph kind="player-a" size="sm" />
                <BombGlyph kind="player-b" size="sm" />
              </span>
              <span>PvP</span>
            </button>
          </div>

          {tab === "solo" ? (
            <div className="bomb-lobby__play">
              <label className="bomb-lobby__stake-label">
                <span className="bomb-lobby__stake-tag">stake</span>
                <input
                  className="bomb-field"
                  type="number"
                  min={1}
                  aria-label="Stake"
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                />
              </label>
              <button type="button" className={`${BOMB_BTN} bomb-cta bomb-cta--join`} onClick={handleSolo}>
                Go
              </button>
            </div>
          ) : (
            <button type="button" className={`${BOMB_BTN} bomb-cta bomb-cta--full`} onClick={onFind}>
              Find match
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
