/**
 * Generic React binding for a worker-hosted SELF-PLAY (bot-vs-bot) session — the solo-lane sibling
 * of {@link useGameMatch}. A game's `useWorker*Session` renames the engineClient commands to its
 * domain (e.g. `start`, `queueAction`) and calls `engineClient.findSolo(windowId, gameId, stake)`.
 *
 * Differs from {@link useGameMatch} in ONE deliberate way: it does NOT fire `engineClient.resume`.
 * In the worker, `resume` selects the PvP lane (and self-play records aren't persisted yet), so
 * firing it from a solo window would mis-route the lane and could clobber the solo snapshot with a
 * stale PvP resume. Config + the visibility flush-pause are wired identically.
 */
import { useEffect, useSyncExternalStore } from "react";
import { engineClient } from "../engineClient";
import { useConfigureEngine } from "./EngineProvider";
import type { MatchSnapshot } from "../engineApi";

export function useGameSolo(windowId: string): MatchSnapshot {
  useConfigureEngine();

  // Pause the worker's snapshot flush while the tab is hidden; resume when it returns.
  useEffect(() => {
    const forward = () => {
      engineClient.setVisibility(
        windowId,
        document.visibilityState === "visible",
      );
    };
    document.addEventListener("visibilitychange", forward);
    window.addEventListener("pagehide", forward);
    return () => {
      document.removeEventListener("visibilitychange", forward);
      window.removeEventListener("pagehide", forward);
    };
  }, [windowId]);

  return useSyncExternalStore(
    (cb) => engineClient.subscribe(windowId, cb),
    () => engineClient.getSnapshot(windowId),
  );
}
