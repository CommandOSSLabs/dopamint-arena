/**
 * Generic React binding for a worker-hosted match — the drop-in replacement for the
 * per-game `useSyncExternalStore` surface today's PvP hooks expose. A game wrapper renames
 * the engineClient commands to its domain (e.g. `fire`, `queueAction`) and calls
 * `engineClient.findMatch(windowId, gameId, setup)` to start.
 *
 * Folds in the three cross-cutting wirings the worker path needs (design §3.1/§8) so a game
 * plugs in with only this hook — no separate `<EngineProvider>` mount, no per-hook resume or
 * visibility plumbing:
 *  - configures the bridge via `useConfigureEngine()` (else `findMatch` throws "engine bridge
 *    not configured");
 *  - fires `engineClient.resume(windowId, gameId)` once on mount so a mid-match reload
 *    reattaches under the flag (the manager dedups, so this is idempotent);
 *  - forwards `visibilitychange`/`pagehide` to `engineClient.setVisibility` so a hidden tab
 *    pauses the worker's snapshot flush.
 */
import { useEffect, useSyncExternalStore } from "react";
import { engineClient } from "../engineClient";
import { useConfigureEngine } from "./EngineProvider";
import type { GameId, MatchSnapshot } from "../engineApi";

export function useGameMatch(windowId: string, gameId: GameId): MatchSnapshot {
  useConfigureEngine();

  // Reattach a persisted match on cold load. Re-runs if the window/game identity changes;
  // the manager only resumes an idle window, so a re-fire mid-match is a no-op.
  useEffect(() => {
    engineClient.resume(windowId, gameId);
  }, [windowId, gameId]);

  // Pause the worker's snapshot flush while the tab is hidden; resume when it returns.
  useEffect(() => {
    const forward = () => {
      engineClient.setVisibility(windowId, document.visibilityState === "visible");
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
