/**
 * Worker-hosted solo (self-play) for World Canvas: two bots paint on a shared canvas.
 * Drop-in replacement for `usePvpWorldCanvas` when `engineEnabled()`.
 */
import { engineEnabled } from "@/engine/flag";
import { engineClient } from "@/engine/engineClient";
import { useGameSolo } from "@/engine/react/useGameSolo";
import type { MatchSnapshot } from "@/engine/engineApi";

export interface WorldCanvasSoloSession {
  status: string;
  auto: boolean;
  error: string | null;
  view: unknown;
  start: (stake?: number) => void;
  reset: () => void;
  toggleAuto: () => void;
  pause: () => void;
  resume: () => void;
  settleNow: () => void;
}

function useWorkerWorldCanvasSolo(windowId: string): WorldCanvasSoloSession {
  const snap = useGameSolo(windowId);
  return {
    status: snap.status,
    auto: snap.auto,
    error: snap.error,
    view: snap.view,
    start: (stake) => engineClient.findSolo(windowId, "world-canvas", stake),
    reset: () => engineClient.reset(windowId),
    toggleAuto: () => engineClient.setAuto(windowId, !snap.auto),
    pause: () => engineClient.setPaused(windowId, true),
    resume: () => engineClient.setPaused(windowId, false),
    settleNow: () => engineClient.settleSolo(windowId),
  };
}

function useLegacyWorldCanvasSolo(windowId: string): WorldCanvasSoloSession {
  // Legacy path: world-canvas solo uses the main-thread PvP hook with auto mode.
  // For now, return a no-op session — the legacy path doesn't have a dedicated solo hook.
  return {
    status: "idle",
    auto: false,
    error: "legacy solo not implemented for world-canvas",
    view: null,
    start: () => {},
    reset: () => {},
    toggleAuto: () => {},
    pause: () => {},
    resume: () => {},
    settleNow: () => {},
  };
}

export const useWorldCanvasSolo: (windowId: string) => WorldCanvasSoloSession =
  engineEnabled() ? useWorkerWorldCanvasSolo : useLegacyWorldCanvasSolo;
