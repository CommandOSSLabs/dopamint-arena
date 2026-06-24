import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { registerWindowDisposer } from "@/lib/windowSessions";
import type { GameWindowProps } from "../types";
import { usePvpBombIt } from "./usePvpBombIt";
import { useBombItSession } from "./useBombItSession";
import { BombLobby } from "./components/BombLobby";
import { BombBoard } from "./components/BombBoard";
import { BombScreen } from "./components/BombScreen";
import { useSoloCabinet, type WindowMode } from "@/shell/cabinet/soloCabinet";
import { useSoloAutoRetry } from "@/lib/useSoloAutoRetry";
import "./bomb-it.css";

// Persisted by windowId so a remount (minimize / maximize / desktop reflow) returns to the live
// session instead of the chooser. Both "solo" and "pvp" survive remount — solo because the
// session lives out-of-React (BombBotSession, windowId-keyed), pvp likewise. Cleared on window close.
const modeStore = new Map<string, "solo" | "pvp">();

/** Default per-game stake for the auto-started solo match (matches the lobby default). */
const AUTO_STAKE = 500;
// Auto-start fires AT MOST ONCE per window: on first open with a wallet we fund + play a solo bot
// match immediately (parity with the other arena games). Module-scoped so a minimize/maximize
// remount never re-funds, and Back returns to the lobby rather than re-triggering. Cleared on close.
const autoStarted = new Map<string, boolean>();

/** Bomb It: pick Solo (bot-vs-bot self-play) or PvP (human-vs-human over a shared tunnel). */
export function BombItWindow({ windowId }: GameWindowProps) {
  const account = useCurrentAccount();
  const [mode, setModeState] = useState<WindowMode>(
    () => modeStore.get(windowId) ?? null,
  );
  const pvp = usePvpBombIt(windowId);
  const solo = useBombItSession(windowId);

  useEffect(() => {
    registerWindowDisposer(windowId, "bomb-it-mode", () => {
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

  // Cabinet "Return to Home": stop solo + show the chooser. Stable (module-const
  // modeStore + stable setModeState + session.reset) so the controller doesn't
  // re-register every render.
  const goHome = useCallback(() => {
    solo.reset();
    modeStore.delete(windowId);
    setModeState(null);
  }, [solo.reset, windowId]);

  // Hand seat A to the human: flip auto off (reads `auto` fresh, so a double take-over is a no-op).
  const goManual = useCallback(() => {
    if (solo.auto) solo.toggleAuto();
  }, [solo.auto, solo.toggleAuto]);
  useSoloCabinet({
    offerable: mode === "solo" && solo.status === "playing" && solo.auto,
    pause: solo.pause,
    resume: solo.resume,
    goManual,
    goHome,
  });

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
      <BombLobby
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
        <BombScreen onBack={backToMenu}>
          <p className="sketch-note text-[var(--sketch-red)]">{solo.error ?? "something went wrong"}</p>
        </BombScreen>
      );
    }
    if (solo.status === "funding") {
      return (
        <BombScreen>
          <span className="sketch-eyebrow">Tunnel</span>
          <h2 className="sketch-title">Funding</h2>
          <p className="sketch-note">
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
        <p className="sketch-note">Loading…</p>
      </BombScreen>
    );
  }

  // PvP
  if (pvp.status === "error") {
    return (
      <BombScreen onBack={backToMenu}>
        <p className="sketch-note text-[var(--sketch-red)]">{pvp.error ?? "something went wrong"}</p>
      </BombScreen>
    );
  }

  if (pvp.status === "matching") {
    return (
      <BombScreen onBack={backToMenu} backLabel="Cancel">
        <span className="sketch-eyebrow">Relay</span>
        <h2 className="sketch-title">Finding match</h2>
        <p className="sketch-note">Matching you with the next player over the relay.</p>
      </BombScreen>
    );
  }

  if (pvp.status === "funding") {
    return (
      <BombScreen>
        <span className="sketch-eyebrow">Tunnel</span>
        <h2 className="sketch-title">Funding</h2>
        <p className="sketch-note">
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
      <p className="sketch-note">Loading…</p>
    </BombScreen>
  );
}
