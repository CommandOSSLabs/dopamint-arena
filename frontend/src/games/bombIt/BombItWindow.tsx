import { useEffect, useState } from "react";
import { registerWindowDisposer } from "@/lib/windowSessions";
import type { GameWindowProps } from "../types";
import { usePvpBombIt } from "./usePvpBombIt";
import { useBombItSession } from "./useBombItSession";
import { BombLobby } from "./components/BombLobby";
import { BombBoard } from "./components/BombBoard";
import "./bomb-it.css";

/** A transitional screen (funding / matching / error) on the game's atmospheric backdrop. */
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="bomb-root">
      <div className="arcade-card">{children}</div>
    </div>
  );
}

// Persisted by windowId so a remount (minimize / maximize / desktop reflow) returns to the live
// PvP match instead of the chooser. Only "pvp" is stored — that session lives out-of-React and
// survives the remount; the Solo session is in-React (refs) and is gone on remount, so it falls
// back to the lobby. Cleared on window close.
const modeStore = new Map<string, "pvp">();

/** Bomb It: pick Solo (bot-vs-bot self-play) or PvP (human-vs-human over a shared tunnel). */
export function BombItWindow({ windowId }: GameWindowProps) {
  const [mode, setModeState] = useState<"solo" | "pvp" | null>(
    () => modeStore.get(windowId) ?? null,
  );
  const pvp = usePvpBombIt(windowId);
  const solo = useBombItSession();

  useEffect(() => {
    registerWindowDisposer(windowId, "bomb-it-mode", () => modeStore.delete(windowId));
  }, [windowId]);
  const setMode = (m: "solo" | "pvp" | null) => {
    if (m === "pvp") modeStore.set(windowId, "pvp");
    else modeStore.delete(windowId);
    setModeState(m);
  };

  const backToMenu = () => {
    if (mode === "solo") solo.reset();
    else if (mode === "pvp") pvp.reset();
    setMode(null);
  };

  if (mode === null) {
    return (
      <BombLobby
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
        <BombBoard
          view={solo.view}
          winner={solo.view.winner}
          role="A"
          stake={solo.stake}
          auto={solo.auto}
          onToggleAuto={solo.toggleAuto}
          onAction={solo.queueAction}
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

  if ((pvp.status === "playing" || pvp.status === "settling" || pvp.status === "settled") && pvp.view !== null) {
    return (
      <BombBoard
        view={pvp.view}
        winner={pvp.winner}
        role={pvp.role}
        stake={pvp.stake}
        auto={pvp.auto}
        onToggleAuto={pvp.toggleAuto}
        onAction={pvp.queueAction}
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
