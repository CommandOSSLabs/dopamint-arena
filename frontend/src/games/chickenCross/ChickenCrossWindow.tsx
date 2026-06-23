import { useEffect, useState } from "react";
import { registerWindowDisposer } from "@/lib/windowSessions";
import type { GameWindowProps } from "../types";
import { usePvpChickenCross } from "./usePvpChickenCross";
import { useChickenCrossSession } from "./useChickenCrossSession";
import { CrossLobby } from "./components/CrossLobby";
import { CrossBoard } from "./components/CrossBoard";
import { CrossScreen } from "./components/CrossScreen";
import "./cross.css";

// Persisted by windowId so a remount (minimize / maximize / desktop reflow) returns to the live
// PvP race instead of the chooser. Only "pvp" is stored — that session lives out-of-React and
// survives the remount; the Solo session is in-React (refs) and is gone on remount, so it falls
// back to the lobby. Cleared on window close.
const modeStore = new Map<string, "pvp">();

/** Chicken Cross: pick Solo (bot-vs-bot self-play) or PvP (two humans race over a shared tunnel). */
export function ChickenCrossWindow({ windowId }: GameWindowProps) {
  const [mode, setModeState] = useState<"solo" | "pvp" | null>(
    () => modeStore.get(windowId) ?? null,
  );
  const pvp = usePvpChickenCross(windowId);
  const solo = useChickenCrossSession();

  useEffect(() => {
    registerWindowDisposer(windowId, "chicken-cross-mode", () => modeStore.delete(windowId));
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
        <CrossScreen onBack={backToMenu}>
          <p className="text-sm text-red-500">{solo.error ?? "something went wrong"}</p>
        </CrossScreen>
      );
    }
    if (solo.status === "funding") {
      return (
        <CrossScreen>
          <span className="cross-lobby__title wal-doto">Funding</span>
          <p className="cross-lobby__copy">Opening + funding the tunnel on-chain… approve in your wallet.</p>
        </CrossScreen>
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
      <CrossScreen>
        <p className="cross-lobby__copy">Loading…</p>
      </CrossScreen>
    );
  }

  if (pvp.status === "error") {
    return (
      <CrossScreen onBack={backToMenu}>
        <p className="text-sm text-red-500">{pvp.error ?? "something went wrong"}</p>
      </CrossScreen>
    );
  }

  if (pvp.status === "matching") {
    return (
      <CrossScreen onBack={backToMenu} backLabel="Cancel">
        <span className="cross-lobby__title wal-doto">Finding…</span>
        <p className="cross-lobby__copy">Matching you with the next player over the relay.</p>
      </CrossScreen>
    );
  }

  if (pvp.status === "funding") {
    return (
      <CrossScreen>
        <span className="cross-lobby__title wal-doto">Funding</span>
        <p className="cross-lobby__copy">Opening + funding the tunnel on-chain… approve in your wallet.</p>
      </CrossScreen>
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
    <CrossScreen>
      <p className="cross-lobby__copy">Loading…</p>
    </CrossScreen>
  );
}
