import { useState } from "react";
import type { GameWindowProps } from "../types";
import { usePvpChickenCross } from "./usePvpChickenCross";
import { useChickenCrossSession } from "./useChickenCrossSession";
import { CrossLobby } from "./components/CrossLobby";
import { CrossBoard } from "./components/CrossBoard";
import "./cross.css";

/** A transitional screen (funding / matching / error) on the game's atmospheric backdrop. */
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="cross-root">
      <div className="arcade-card">{children}</div>
    </div>
  );
}

/** Chicken Cross: pick Solo (bot-vs-bot self-play) or PvP (two humans race over a shared tunnel). */
export function ChickenCrossWindow(_props: GameWindowProps) {
  const [mode, setMode] = useState<"solo" | "pvp" | null>(null);
  const pvp = usePvpChickenCross();
  const solo = useChickenCrossSession();

  const backToMenu = () => {
    if (mode === "solo") solo.reset();
    else if (mode === "pvp") pvp.reset();
    setMode(null);
  };

  if (mode === null) {
    return (
      <CrossLobby
        onSolo={(s) => {
          setMode("solo");
          solo.start(s);
        }}
        onFind={() => {
          setMode("pvp");
          pvp.findMatch();
        }}
      />
    );
  }

  if (mode === "solo") {
    if (solo.status === "error") {
      return (
        <Screen>
          <p className="text-sm text-red-400">{solo.error ?? "something went wrong"}</p>
          <button className="arcade-cta arcade-cta--ghost" onClick={backToMenu}>Back</button>
        </Screen>
      );
    }
    if (solo.status === "funding") {
      return (
        <Screen>
          <span className="arcade-title wal-doto text-gold" style={{ fontSize: 22 }}>FUNDING</span>
          <p className="arcade-sub">Opening + funding the tunnel on-chain… approve in your wallet.</p>
        </Screen>
      );
    }
    if (
      (solo.status === "playing" || solo.status === "settling" || solo.status === "settled") &&
      solo.view !== null
    ) {
      return (
        <CrossBoard
          view={solo.view}
          winner={solo.view.winner}
          role="A"
          stake={solo.stake}
          seed={solo.view.seed}
          done={solo.status === "settled"}
          auto={solo.auto}
          onToggleAuto={solo.toggleAuto}
          onDir={solo.setDir}
          onPlayAgain={backToMenu}
        />
      );
    }
    return (
      <Screen>
        <p className="arcade-sub">Loading…</p>
      </Screen>
    );
  }

  // PvP
  if (pvp.status === "error") {
    return (
      <Screen>
        <p className="text-sm text-red-400">{pvp.error ?? "something went wrong"}</p>
        <button className="arcade-cta arcade-cta--ghost" onClick={backToMenu}>Back</button>
      </Screen>
    );
  }

  if (pvp.status === "matching") {
    return (
      <Screen>
        <span className="arcade-title wal-doto text-gold" style={{ fontSize: 20 }}>FINDING…</span>
        <p className="arcade-sub">Matching you with the next player over the relay.</p>
        <button className="arcade-cta arcade-cta--ghost" onClick={backToMenu}>Cancel</button>
      </Screen>
    );
  }

  if (pvp.status === "funding") {
    return (
      <Screen>
        <span className="arcade-title wal-doto text-gold" style={{ fontSize: 22 }}>FUNDING</span>
        <p className="arcade-sub">Opening + funding the tunnel on-chain… approve in your wallet.</p>
      </Screen>
    );
  }

  if (pvp.status === "disconnected") {
    return (
      <Screen>
        <span className="arcade-title wal-doto" style={{ fontSize: 20, color: "#fb7185", textShadow: "0 0 18px rgba(251,113,133,0.4)" }}>
          CONNECTION LOST
        </span>
        <p className="arcade-sub">The match can't be resumed. Your stake stays safe on-chain — settlement still resolves cooperatively.</p>
        <button className="arcade-cta arcade-cta--ghost" onClick={backToMenu}>Back</button>
      </Screen>
    );
  }

  if ((pvp.status === "playing" || pvp.status === "settling" || pvp.status === "settled") && pvp.view !== null) {
    return (
      <CrossBoard
        view={pvp.view}
        winner={pvp.winner}
        role={pvp.role}
        stake={pvp.stake}
        seed={pvp.view.seed}
        done={pvp.status === "settled"}
        auto={pvp.auto}
        onToggleAuto={pvp.toggleAuto}
        onDir={pvp.setDir}
        onPlayAgain={backToMenu}
      />
    );
  }

  return (
    <Screen>
      <p className="arcade-sub">Loading…</p>
    </Screen>
  );
}
