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
import { useEffect, useRef, useSyncExternalStore } from "react";
import { engineClient } from "../engineClient";
import { useConfigureEngine } from "./EngineProvider";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
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

  const snap = useSyncExternalStore(
    (cb) => engineClient.subscribe(windowId, "solo", cb),
    () => engineClient.getSnapshot(windowId, "solo"),
  );

  // Local TPS: the worker self-play runs off the main thread, so it can't reach the telemetry. Feed
  // the delta of its cumulative co-signed updates into the SCOPED `recordActions` (GameContent tags
  // it with this window's gameId), which is what the window's TPS chip samples when the backend
  // per-game feed is absent. A drop in `moves` (a new match reset the worker counter) just re-bases.
  const { report } = useTelemetry();
  const prevMoves = useRef(0);
  useEffect(() => {
    const moves = snap.moves ?? 0;
    const delta = moves - prevMoves.current;
    prevMoves.current = moves;
    if (delta > 0) report.recordActions(delta);
  }, [snap.moves, report]);

  return snap;
}
