/**
 * Worker-hosted solo (self-play) for World Canvas: two bots paint on a shared canvas, rendered by
 * the rich {@link ./ui/WorldCanvas WorldCanvas} (via {@link ./ui/SoloCanvasView SoloCanvasView}).
 * The worker view is the PvP protocol's `PvpCell[]` stream, so the seat-A paint buffer here mirrors
 * the online PvP hook: `paint` stamps each cell with a per-seat seq and flushes the pending run to
 * the engine as ONE co-signed move on seat A (consumed only while Auto is off / manual).
 */
import { useCallback, useEffect, useRef } from "react";
import { engineEnabled } from "@/engine/flag";
import { engineClient } from "@/engine/engineClient";
import { useGameSolo } from "@/engine/react/useGameSolo";
import {
  CHUNK_SIZE,
  MAX_BATCH_CELLS,
  type PvpCell,
  type PvpCellMove,
} from "sui-tunnel-ts/protocol/worldCanvasPvp";

export interface WorldCanvasSoloSession {
  status: string;
  auto: boolean;
  error: string | null;
  view: PvpCell[] | null;
  start: (stake?: number) => void;
  reset: () => void;
  toggleAuto: () => void;
  setAuto: (on: boolean) => void;
  pause: () => void;
  resume: () => void;
  settleNow: () => void;
  /** Take-the-wheel: queue a painted seat-A cell (global-pixel coords). Buffered and co-signed as a
   *  run on seat A when Auto is off; a no-op visually while Auto is on (the engine drops it). */
  paint: (gx: number, gy: number, color: number) => void;
}

/** Flatten a global-pixel cell to a (chunk, in-chunk) seat-A move with its per-seat `seq`. */
function toCellMove(
  gx: number,
  gy: number,
  color: number,
  seq: number,
): PvpCellMove {
  const cx = Math.floor(gx / CHUNK_SIZE);
  const cy = Math.floor(gy / CHUNK_SIZE);
  return { cx, cy, x: gx - cx * CHUNK_SIZE, y: gy - cy * CHUNK_SIZE, color, seq };
}

function useWorkerWorldCanvasSolo(windowId: string): WorldCanvasSoloSession {
  const snap = useGameSolo(windowId);
  const view = (snap.view as PvpCell[] | null) ?? null;
  const auto = snap.auto;

  // YOUR un-confirmed seat-A cells, FIFO. `paint` stamps each with a per-seat seq; the buffer's
  // head (≤ batch cap) is flushed as the next seat-A move. Re-sending is parity-safe (the protocol
  // folds each seq at most once), so the buffer stays at-least-once.
  const pendingRef = useRef<PvpCellMove[]>([]);
  const nextSeqRef = useRef(1);
  const confirmedSeqRef = useRef(0);

  const flush = useCallback(() => {
    const head = pendingRef.current.slice(0, MAX_BATCH_CELLS);
    engineClient.submitInput(windowId, { cells: head });
  }, [windowId]);

  // Advance the confirmed seat-A high-water from the view (a cell's `pseq` survives the render cap),
  // trim confirmed cells, and — while manual — re-flush the remaining run. While Auto is on, drop
  // the buffer so a later take-over can't replay already-skipped seqs.
  useEffect(() => {
    let myMax = confirmedSeqRef.current;
    for (const c of view ?? []) {
      if (c.by === "A" && c.pseq > myMax) myMax = c.pseq;
    }
    confirmedSeqRef.current = myMax;
    if (nextSeqRef.current <= myMax) nextSeqRef.current = myMax + 1;
    if (auto) {
      pendingRef.current = [];
      return;
    }
    pendingRef.current = pendingRef.current.filter((c) => c.seq > myMax);
    flush();
  }, [view, auto, flush]);

  const paint = useCallback(
    (gx: number, gy: number, color: number) => {
      const seq = nextSeqRef.current++;
      pendingRef.current.push(toCellMove(gx, gy, color, seq));
      flush();
    },
    [flush],
  );

  return {
    status: snap.status,
    auto,
    error: snap.error,
    view,
    start: (stake) => engineClient.findSolo(windowId, "world-canvas", stake),
    reset: () => engineClient.reset(windowId),
    toggleAuto: () => engineClient.setAuto(windowId, !auto),
    setAuto: (on) => engineClient.setAuto(windowId, on),
    pause: () => engineClient.setPaused(windowId, true),
    resume: () => engineClient.setPaused(windowId, false),
    settleNow: () => engineClient.settleSolo(windowId),
    paint,
  };
}

function useLegacyWorldCanvasSolo(_windowId: string): WorldCanvasSoloSession {
  // Legacy path: world-canvas solo has no dedicated main-thread solo hook (the legacy CanvasView
  // uses useWorldCanvasOnchain directly). Return a no-op so `?engine=legacy` never hits this.
  return {
    status: "idle",
    auto: false,
    error: "legacy solo not implemented for world-canvas",
    view: null,
    start: () => {},
    reset: () => {},
    toggleAuto: () => {},
    setAuto: () => {},
    pause: () => {},
    resume: () => {},
    settleNow: () => {},
    paint: () => {},
  };
}

export const useWorldCanvasSolo: (windowId: string) => WorldCanvasSoloSession =
  engineEnabled() ? useWorkerWorldCanvasSolo : useLegacyWorldCanvasSolo;
