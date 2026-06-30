/**
 * Worker-hosted solo (self-play) for Battleship: two bots play commit-reveal battleship.
 * Drop-in replacement for `useBattleshipPvp` when `engineEnabled()`.
 */
import { engineEnabled } from "@/engine/flag";
import { engineClient } from "@/engine/engineClient";
import { useGameSolo } from "@/engine/react/useGameSolo";
import type { MatchSnapshot } from "@/engine/engineApi";

export interface BattleshipSoloSession {
  status: string;
  auto: boolean;
  error: string | null;
  view: unknown;
  score: { you: number; foe: number };
  start: (stake?: number) => void;
  reset: () => void;
  toggleAuto: () => void;
  pause: () => void;
  resume: () => void;
  settleNow: () => void;
  /** Take over seat A (X) and fire at this cell on the next manual tick. */
  fire: (cell: number) => void;
}

function useWorkerBattleshipSolo(windowId: string): BattleshipSoloSession {
  const snap = useGameSolo(windowId);
  return {
    status: snap.status,
    auto: snap.auto,
    error: snap.error,
    view: snap.view,
    score: snap.score ?? { you: 0, foe: 0 },
    start: (stake) => engineClient.findSolo(windowId, "battleship", stake),
    reset: () => engineClient.reset(windowId),
    toggleAuto: () => engineClient.setAuto(windowId, !snap.auto),
    pause: () => engineClient.setPaused(windowId, true),
    resume: () => engineClient.setPaused(windowId, false),
    settleNow: () => engineClient.settleSolo(windowId),
    fire: (cell) => engineClient.submitInput(windowId, cell),
  };
}

function useLegacyBattleshipSolo(_windowId: string): BattleshipSoloSession {
  return {
    status: "idle",
    auto: false,
    error: "legacy solo not implemented for battleship",
    view: null,
    score: { you: 0, foe: 0 },
    start: () => {},
    reset: () => {},
    toggleAuto: () => {},
    pause: () => {},
    resume: () => {},
    settleNow: () => {},
    fire: () => {},
  };
}

export const useBattleshipSolo: (windowId: string) => BattleshipSoloSession =
  engineEnabled() ? useWorkerBattleshipSolo : useLegacyBattleshipSolo;
