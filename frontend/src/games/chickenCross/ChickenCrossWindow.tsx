import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { registerWindowDisposer } from "@/lib/windowSessions";
import type { GameWindowProps } from "../types";
import { usePvpChickenCross } from "./usePvpChickenCross";
import { useChickenCrossSession } from "./useChickenCrossSession";
import { CrossLobby } from "./components/CrossLobby";
import { CrossBoard } from "./components/CrossBoard";
import { CrossScreen } from "./components/CrossScreen";
import { useSoloCabinet, type WindowMode } from "@/shell/cabinet/soloCabinet";
import { useSoloAutoRetry } from "@/lib/useSoloAutoRetry";
import "./cross.css";

// Persisted by windowId so a remount (minimize / maximize / desktop reflow) returns to the live
// session instead of the chooser. Both "solo" and "pvp" survive remount — solo because the
// session lives out-of-React (CrossBotSession, windowId-keyed), pvp likewise. Cleared on window close.
const modeStore = new Map<string, "solo" | "pvp">();

/** Default per-game stake for the auto-started solo match (matches the lobby default). */
const AUTO_STAKE = 500;
// Auto-start fires AT MOST ONCE per window: on first open with a wallet we fund + play a solo bot
// match immediately (parity with the other arena games). Module-scoped so a minimize/maximize
// remount never re-funds, and Back returns to the lobby rather than re-triggering. Cleared on close.
const autoStarted = new Map<string, boolean>();

/** Chicken Cross: pick Solo (bot-vs-bot self-play) or PvP (two humans race over a shared tunnel). */
export function ChickenCrossWindow({ windowId }: GameWindowProps) {
  const account = useCurrentAccount();
  const [mode, setModeState] = useState<WindowMode>(
    () => modeStore.get(windowId) ?? null,
  );
  const pvp = usePvpChickenCross(windowId);
  const solo = useChickenCrossSession(windowId);

  useEffect(() => {
    registerWindowDisposer(windowId, "chicken-cross-mode", () => {
      modeStore.delete(windowId);
      autoStarted.delete(windowId);
    });
  }, [windowId]);
  const setMode = (m: WindowMode) => {
    if (m === "pvp" || m === "solo") modeStore.set(windowId, m);
    else modeStore.delete(windowId);
    setModeState(m);
  };

  const backToMenu = () => {
    if (mode === "solo") solo.reset();
    else if (mode === "pvp") pvp.reset();
    setMode(null);
  };

  const goHome = useCallback(() => {
    solo.reset();
    modeStore.delete(windowId);
    setModeState(null);
  }, [solo.reset, windowId]);

  useSoloCabinet(solo, mode, goHome);

  // Auto-retry a failed solo start every 5s while it sits in "error" (cold-start faucet race /
  // transient sponsor blip) so the unattended bot game self-heals. Retries with the stake last
  // started (auto-start uses AUTO_STAKE; the lobby's chosen stake otherwise).
  const lastStakeRef = useRef(AUTO_STAKE);
  const retrySolo = useCallback(() => {
    solo.reset();
    solo.start(lastStakeRef.current);
  }, [solo.reset, solo.start]);
  useSoloAutoRetry(mode === "solo", solo.status, retrySolo);

  // First open with a wallet connected → fund + play a solo bot match immediately (parity with the
  // other arena games), instead of landing on the lobby. Once-only per window: a remount never
  // re-funds (the out-of-React session is already live), and Back returns to the lobby, not a refund.
  useEffect(() => {
    if (autoStarted.get(windowId)) return;
    if (mode !== null || !account || solo.status !== "idle") return;
    autoStarted.set(windowId, true);
    setMode("solo");
    solo.start(AUTO_STAKE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, mode, solo.status, windowId]);

  if (mode === null) {
    return (
      <CrossLobby
        onSolo={(s) => {
          lastStakeRef.current = s;
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
          score={solo.score}
          gamesPlayed={solo.gamesPlayed}
          onSettle={solo.status === "playing" ? solo.settleNow : undefined}
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
