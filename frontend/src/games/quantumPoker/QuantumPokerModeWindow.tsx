import { useEffect, useState, type CSSProperties } from "react";
import { registerWindowDisposer } from "@/lib/windowSessions";
import type { GameWindowProps } from "../types";
import { QuantumPokerBotVsBotWindow } from "./QuantumPokerBotVsBotWindow";
import { QuantumPokerPvpWindow } from "./QuantumPokerPvpWindow";
import { QuantumPokerWindow } from "./QuantumPokerWindow";

type Mode = "bot" | "pvp" | "auto";

const modeStore = new Map<string, Mode | null>();

const QP_MODE_STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--qp-ink": "#0a0c16",
  "--qp-violet": "#613dff",
  "--qp-lilac": "#cab1ff",
  "--qp-gold": "#fbbf24",
  "--qp-mint": "#9cefcf",
};

const BUTTON_BASE =
  "rounded-lg px-4 py-2 text-[12px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qp-lilac)]/60";

export function QuantumPokerModeWindow(props: GameWindowProps) {
  const { windowId } = props;
  const [mode, setModeState] = useState<Mode | null>(
    () => modeStore.get(windowId) ?? null,
  );

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
    return <QuantumPokerPvpWindow {...props} />;
  }

  if (mode === "bot") {
    return (
      <QuantumPokerWindow
        {...props}
        lane="bot"
        onExit={() => setMode(null)}
      />
    );
  }

  if (mode === "auto") {
    return (
      <QuantumPokerBotVsBotWindow
        {...props}
        onExit={() => setMode(null)}
      />
    );
  }

  return (
    <div
      style={QP_MODE_STYLE}
      className="flex h-full min-h-[14rem] flex-col items-center justify-center gap-3 overflow-hidden bg-[var(--qp-ink)] p-5 text-center text-slate-100"
    >
      <div className="flex flex-col items-center gap-1">
        <span className="rounded-sm bg-[var(--qp-violet)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-white">
          heads-up tunnel
        </span>
        <h2 className="wal-doto text-lg text-slate-50">QUANTUM POKER</h2>
      </div>

      <div className="grid w-full max-w-[19rem] gap-2">
        <button
          type="button"
          onClick={() => setMode("bot")}
          className={`${BUTTON_BASE} bg-[var(--qp-gold)] text-[#211702] shadow-[0_0_22px_-10px_var(--qp-gold)] hover:brightness-105`}
        >
          Play vs Bot
        </button>
        <button
          type="button"
          onClick={() => setMode("pvp")}
          className={`${BUTTON_BASE} border border-[var(--qp-lilac)]/30 bg-[var(--qp-violet)]/20 text-[var(--qp-lilac)] hover:bg-[var(--qp-violet)]/30`}
        >
          Find PvP Match
        </button>
        <button
          type="button"
          onClick={() => setMode("auto")}
          className={`${BUTTON_BASE} border border-[var(--qp-mint)]/25 bg-[var(--qp-mint)]/10 text-[var(--qp-mint)] hover:bg-[var(--qp-mint)]/15`}
        >
          Watch Bots (Auto)
        </button>
      </div>

      <p className="max-w-[19rem] text-[11px] leading-relaxed text-slate-500">
        Bot mode uses the configured poker bot server. PvP uses the live relay.
        Auto opens, funds, plays, settles, and repeats real bot tunnels.
      </p>
    </div>
  );
}
