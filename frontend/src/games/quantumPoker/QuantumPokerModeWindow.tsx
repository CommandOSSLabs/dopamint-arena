import { useEffect, useState } from "react";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { hasResumableMatch } from "@/pvp/resume";
import type { GameWindowProps } from "../types";
import { QuantumPokerBotVsBotWindow } from "./QuantumPokerBotVsBotWindow";
import { QuantumPokerPvpWindow } from "./QuantumPokerPvpWindow";
import { SketchDefs } from "../sketch";

type Mode = "play" | "pvp" | "auto";

const modeStore = new Map<string, Mode | null>();

export function QuantumPokerModeWindow(props: GameWindowProps) {
  const { windowId } = props;
  // Default to "auto" (watch bots) on load; Back from any mode returns to the menu (null).
  // Exception: a page reload wipes the in-memory modeStore, so if an in-flight PvP match is
  // persisted, reopen the PvP lane — its hook's resume() then continues the table instead of the
  // player landing on watch-bots. A finished/unrestorable record self-heals: resume() clears it
  // and falls back to the PvP idle screen.
  const [mode, setModeState] = useState<Mode | null>(() => {
    const stored = modeStore.get(windowId);
    if (stored !== undefined) return stored;
    if (hasResumableMatch("quantum-poker")) return "pvp";
    return "auto";
  });

  useEffect(() => {
    registerWindowDisposer(windowId, "quantum-poker-mode", () => {
      modeStore.delete(windowId);
    });
  }, [windowId]);

  const setMode = (nextMode: Mode | null) => {
    if (nextMode === null) modeStore.delete(windowId);
    else modeStore.set(windowId, nextMode);
    setModeState(nextMode);
  };

  if (mode === "pvp") {
    return <QuantumPokerPvpWindow {...props} onExit={() => setMode(null)} />;
  }

  if (mode === "auto" || mode === "play") {
    return (
      <QuantumPokerBotVsBotWindow
        {...props}
        onExit={() => setMode(null)}
        autoTakeOver={mode === "play"}
      />
    );
  }

  return (
    <div className="sketch grid h-full min-h-[14rem] place-items-center overflow-hidden p-[clamp(14px,4cqmin,32px)] text-center">
      <SketchDefs />
      <div className="sketch-panel sketch-stroke flex max-w-[min(22rem,92%)] flex-col items-center gap-[clamp(12px,3.2cqmin,22px)] p-[clamp(16px,4.5cqmin,30px)]">
        <div className="flex flex-col items-center gap-[clamp(2px,0.8cqmin,6px)]">
          <span className="sketch-eyebrow">Heads-up tunnel</span>
          <h2 className="qp-title text-[clamp(20px,6cqmin,38px)]">
            Quantum Poker
          </h2>
        </div>

        <div className="flex w-fit flex-col gap-[clamp(8px,2.4cqmin,14px)]">
          <button
            type="button"
            onClick={() => setMode("play")}
            className="sketch-btn sketch-btn--go"
          >
            Play vs Bot
          </button>
          <button
            type="button"
            onClick={() => setMode("pvp")}
            className="sketch-btn sketch-btn--go"
          >
            Find PvP Match
          </button>
        </div>

        <p className="sketch-note">
          Take a seat against a bot, or find a live PvP match over the relay.
          Watch Bots runs by default — Back to reach this menu.
        </p>
      </div>
    </div>
  );
}
