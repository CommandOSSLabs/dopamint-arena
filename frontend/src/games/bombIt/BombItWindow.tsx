import { useEffect, useState } from "react";
import { registerWindowDisposer } from "@/lib/windowSessions";
import type { GameWindowProps } from "../types";
import { usePvpBombIt } from "./usePvpBombIt";
import { useBombItSession } from "./useBombItSession";
import { BombLobby } from "./components/BombLobby";
import { BombBoard } from "./components/BombBoard";
import { BombScreen } from "./components/BombScreen";
import "./bomb-it.css";

// Persisted by windowId so a remount (minimize / maximize / desktop reflow) returns to the live
// session instead of the chooser. Both "solo" and "pvp" survive remount — solo because the
// session lives out-of-React (BombBotSession, windowId-keyed), pvp likewise. Cleared on window close.
const modeStore = new Map<string, "solo" | "pvp">();

/** Bomb It: pick Solo (bot-vs-bot self-play) or PvP (human-vs-human over a shared tunnel). */
export function BombItWindow({ windowId }: GameWindowProps) {
  const [mode, setModeState] = useState<"solo" | "pvp" | null>(
    () => modeStore.get(windowId) ?? null,
  );
  const pvp = usePvpBombIt(windowId);
  const solo = useBombItSession(windowId);

  useEffect(() => {
    registerWindowDisposer(windowId, "bomb-it-mode", () => modeStore.delete(windowId));
  }, [windowId]);
  const setMode = (m: "solo" | "pvp" | null) => {
    if (m === "pvp" || m === "solo") modeStore.set(windowId, m);
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
        <BombScreen onBack={backToMenu}>
          <p className="text-sm text-rose-300">{solo.error ?? "something went wrong"}</p>
        </BombScreen>
      );
    }
    if (solo.status === "funding") {
      return (
        <BombScreen>
          <span className="bomb-status-title wal-doto">Funding</span>
          <p className="bomb-lobby__copy">
            Opening + funding the tunnel on-chain… approve in your wallet.
          </p>
        </BombScreen>
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
          score={solo.score}
          gamesPlayed={solo.gamesPlayed}
          onSettle={solo.status === "playing" ? solo.settleNow : undefined}
        />
      );
    }
    return (
      <BombScreen>
        <p className="bomb-lobby__copy">Loading…</p>
      </BombScreen>
    );
  }

  // PvP
  if (pvp.status === "error") {
    return (
      <BombScreen onBack={backToMenu}>
        <p className="text-sm text-rose-300">{pvp.error ?? "something went wrong"}</p>
      </BombScreen>
    );
  }

  if (pvp.status === "matching") {
    return (
      <BombScreen onBack={backToMenu} backLabel="Cancel">
        <span className="bomb-status-title wal-doto">Finding match</span>
        <p className="bomb-lobby__copy">Matching you with the next player over the relay.</p>
      </BombScreen>
    );
  }

  if (pvp.status === "funding") {
    return (
      <BombScreen>
        <span className="bomb-status-title wal-doto">Funding</span>
        <p className="bomb-lobby__copy">
          Opening + funding the tunnel on-chain… approve in your wallet.
        </p>
      </BombScreen>
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
    <BombScreen>
      <p className="bomb-lobby__copy">Loading…</p>
    </BombScreen>
  );
}
