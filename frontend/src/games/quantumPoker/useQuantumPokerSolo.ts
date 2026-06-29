/**
 * Flag dispatch for the Quantum Poker self-play (watch-bots / take-over) lane. Default is the
 * legacy main-thread {@link useQuantumPokerAuto}; `?engine=worker` (engine/flag.ts) selects the
 * worker-hosted `SoloEngine` path below. Both return the same {@link QuantumPokerAutoSession}, so
 * `QuantumPokerBotVsBotWindow` is agnostic. Bound once at module load so the hook identity is
 * stable per session (rules-of-hooks), exactly like the bomb-it/chicken-cross solo hooks.
 *
 * Worker-path limitations (documented, behind the flag): personas show as generic "Bot A/B" (the
 * snapshot carries no persona label), the per-turn auto-fold countdown isn't enforced (`secondsLeft`
 * stays null), the take-over / 🤖-Auto distinction collapses to the engine's single auto flag, and
 * one funded tunnel hosts ONE multi-hand match (no multi-tunnel re-open loop). The throughput
 * watch-bots showcase — the SoloEngine's purpose — is fully supported.
 */
import { useEffect } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import type { PokerMove } from "sui-tunnel-ts/protocol/quantumPoker";
import { engineEnabled } from "@/engine/flag";
import { engineClient } from "@/engine/engineClient";
import { useGameSolo } from "@/engine/react/useGameSolo";
import type { MatchSnapshot } from "@/engine/engineApi";
import {
  useQuantumPokerAuto,
  type AutoStatus,
  type QuantumPokerAutoSession,
} from "./useQuantumPokerAuto";
import { isHumanBettingTurn, legalPokerActions } from "./pokerSelfPlay";
import type { PokerSoloState } from "./quantumPokerSoloSpec";

/** Map the engine's status enum onto the legacy attract-loop status the window expects. */
function toAutoStatus(status: MatchSnapshot["status"]): AutoStatus {
  switch (status) {
    case "playing":
    case "settling":
      return "running";
    case "settled":
      return "ended";
    case "funding":
    case "matching":
      return "funding";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

/** Windows that have fired their one-shot auto-start (mirrors the legacy `didAutoStart` latch, so a
 *  later remount/minimize doesn't reopen a tunnel and a user Stop isn't overridden). */
const autoStartedWindows = new Set<string>();

/** Worker path (`?engine=worker`): the funded tunnel + per-hand loop run in a dedicated Web Worker
 *  (`SoloEngine`); this hook only renders the snapshot and forwards commands via `engineClient`. */
function useWorkerQuantumPokerSolo(windowId: string): QuantumPokerAutoSession {
  const account = useCurrentAccount();
  const snap = useGameSolo(windowId) as MatchSnapshot<PokerSoloState>;
  const state = snap.view;
  const manual = !snap.auto;

  // Auto-start watch-bots once a wallet is connected (the bots self-fund via the bridge, but never
  // open on a bare page load — same gate as the legacy hook). One-shot per window.
  useEffect(() => {
    if (!account || snap.status !== "idle") return;
    if (autoStartedWindows.has(windowId)) return;
    autoStartedWindows.add(windowId);
    engineClient.findSolo(windowId, "quantum-poker");
  }, [account, windowId, snap.status]);

  // Seat A (the player's own bot) always shows its holes. Seat B stays hidden until showdown while a
  // human plays (only `shownHoleB`); in attract both seats are shown (spectator view). The full state
  // never reaches the table's card rows — only these arrays do.
  const holesA = state ? (state.holeA ?? state.shownHoleA ?? []) : [];
  const holesB = state
    ? manual
      ? (state.shownHoleB ?? [])
      : (state.holeB ?? [])
    : [];
  const legal =
    manual && state && isHumanBettingTurn(state, "A")
      ? legalPokerActions(state, "A")
      : null;

  return {
    status: toAutoStatus(snap.status),
    personas: null,
    score: { a: snap.score?.you ?? 0, b: snap.score?.foe ?? 0 },
    tunnels: snap.tunnelId ? 1 : 0,
    actions: state?.moves ?? 0,
    hands: state ? Number(state.handNo) : 0,
    balances: { a: state?.balanceA ?? 0n, b: state?.balanceB ?? 0n },
    funded: !!account, // the worker funds both seats via the bridge at start — no separate step
    canFundFromWallet: false,
    error: snap.error,
    state,
    holesA,
    holesB,
    manual,
    autoSeat: false,
    legal,
    secondsLeft: null, // no per-turn auto-fold timer on the worker path (documented limitation)
    paused: false,
    fund: () => {},
    fundFromWallet: () => {},
    startAuto: () => engineClient.findSolo(windowId, "quantum-poker"),
    stopAuto: () => engineClient.reset(windowId),
    takeOver: () => engineClient.setAuto(windowId, false),
    returnHome: () => engineClient.setAuto(windowId, true),
    setAutoSeat: (on) => engineClient.setAuto(windowId, on),
    act: (move: PokerMove) => engineClient.submitInput(windowId, move),
    pause: () => engineClient.setVisibility(windowId, false),
    resume: () => engineClient.setVisibility(windowId, true),
    reset: () => engineClient.reset(windowId),
  };
}

export const useQuantumPokerSolo: (
  windowId: string,
) => QuantumPokerAutoSession = engineEnabled()
  ? useWorkerQuantumPokerSolo
  : useQuantumPokerAuto;
