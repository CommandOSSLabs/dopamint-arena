import { useState } from "react";
import "../cross.css";

/** Splash/menu: Solo (bots over a local tunnel) or PvP (auto-matched with another player). */
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
    <div className="cross-root">
      <div className="arcade-card">
        <h2 className="arcade-title wal-doto text-gold">CHICKEN CROSS</h2>

        <div className="arcade-seg">
          <button className={`arcade-seg__btn${tab === "solo" ? " arcade-seg__btn--on" : ""}`} onClick={() => setTab("solo")}>
            Solo
          </button>
          <button className={`arcade-seg__btn${tab === "pvp" ? " arcade-seg__btn--on" : ""}`} onClick={() => setTab("pvp")}>
            PvP
          </button>
        </div>

        {tab === "solo" ? (
          <>
            <p className="arcade-sub">Two bots race up the neon highway over a real Sui tunnel — one signature funds both seats. Take the wheel anytime with the Auto toggle.</p>
            <div className="flex flex-col items-center gap-1.5">
              <span className="arcade-label">Stake per seat (MIST)</span>
              <input className="arcade-field" type="number" min={1} value={stake} onChange={(e) => setStake(e.target.value)} />
            </div>
            <button className="arcade-cta" onClick={handleSolo}>Start Solo</button>
          </>
        ) : (
          <>
            <p className="arcade-sub">Auto-matched with the next player over a real Sui tunnel. Your bot races for you by default — flip to Manual to steer yourself.</p>
            <button className="arcade-cta" onClick={onFind}>Find Match</button>
          </>
        )}
      </div>
    </div>
  );
}
