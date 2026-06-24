import { useState } from "react";
import { CROSS_BTN, CROSS_STYLE } from "../crossTheme";
import { CrossChicken } from "./crossSprites";
import "../cross.css";

/** Splash/menu — compact footprint, playful pane styling. */
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
    <div className="cross-lobby" style={CROSS_STYLE}>
      <div className="cross-lobby__card">
        <div className="cross-lobby__head">
          <div className="cross-lobby__brand">
            <span className="cross-lobby__mascot" aria-hidden>
              <CrossChicken party="a" mini />
            </span>
            <h2 className="cross-lobby__title">Chicken Cross</h2>
          </div>
          <div className="cross-seg" role="tablist" aria-label="Game mode">
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
        </div>

        {tab === "solo" ? (
          <div className="cross-lobby__action">
            <input
              className="cross-field"
              type="number"
              min={1}
              aria-label="Stake"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
            />
            <button type="button" className={`${CROSS_BTN} cross-cta cross-cta--join`} onClick={handleSolo}>
              Go
            </button>
          </div>
        ) : (
          <button type="button" className={`${CROSS_BTN} cross-cta cross-cta--full`} onClick={onFind}>
            Find match
          </button>
        )}
      </div>
    </div>
  );
}
