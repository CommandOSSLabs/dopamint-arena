/**
 * Online PvP for World Canvas: two real humans matched over the relay co-sign ONE
 * genuine 2-party tunnel and co-draw a shared canvas. Built on the shared, proven
 * {@link createPvpMatchHook} engine (matchmaking → fund → propose/ack co-sign → settle),
 * specialized by the {@link WorldCanvasPvpProtocol} (rolling-digest co-sign + a render-only
 * cell list) and a BATCHED paint move. With Auto on, both seats are bot-driven.
 *
 * Throughput: the channel is turn-based (the seats co-sign alternately), so one cell per
 * turn would crawl and a fast drag would lose most of its cells. Instead each co-signed
 * move carries a RUN of cells: `paint()` buffers your cells and flushes the whole pending
 * run as ONE move on your turn, trimming cells from the buffer as they confirm in the
 * view — so a drag crosses as a stroke, not sparse dots. The batch move carries bigint
 * chunk indices, so the tunnel is built with {@link worldCanvasPvpMoveCodec} (JSON can't
 * carry bigint) — that is what lets the opponent receive intact coordinates.
 */
import { useCallback, useEffect, useRef } from "react";
import {
  createPvpMatchHook,
  type PvpMatch,
  type PvpStatus,
} from "@/pvp/pvpMatchHook";
import type { Role } from "@/pvp/mpClient";
import {
  WorldCanvasPvpProtocol,
  worldCanvasPvpMoveCodec,
  CHUNK_SIZE,
  MAX_BATCH_CELLS,
  type PvpCanvasState,
  type PvpCell,
  type PvpCellMove,
  type PvpPaintMove,
} from "./pvpProtocol";
import { makeWorldCanvasPvpResumeAdapter } from "./pvpResumeAdapter";

/** A seat's queued paint == the co-signed batch move (a run of cells). */
export type PaintIntent = PvpPaintMove;

/** Default when no human paint is pending: an empty run (a no-op co-sign tick). */
const IDLE_INTENT: PaintIntent = { cells: [] };

function intentToMove(_role: Role, i: PaintIntent): PvpPaintMove {
  return i;
}

function readIntent(_role: Role, m: PvpPaintMove | null): PaintIntent | undefined {
  return m ?? undefined;
}

const usePvpMatch = createPvpMatchHook<
  PvpCanvasState,
  PvpPaintMove,
  PaintIntent,
  PvpCell[]
>({
  game: "world-canvas",
  stepMs: 80,
  stake: 1n, // 1 MIST per seat — free/draw, never shifts (each human funds its own seat)
  makeProtocol: () => new WorldCanvasPvpProtocol(),
  // The batch move carries bigint chunk coords; the JSON relay can't carry bigint, so the
  // tunnel (de)serializes moves through this codec — else the opponent decodes empty runs.
  moveCodec: worldCanvasPvpMoveCodec,
  deriveView: (s) => s.cells,
  makeResumeAdapter: makeWorldCanvasPvpResumeAdapter,
  idleIntent: IDLE_INTENT,
  intentToMove,
  readIntent,
});

export type { PvpStatus };

export interface PvpWorldCanvas
  extends Omit<PvpMatch<PvpCanvasState, PaintIntent, PvpCell[]>, "setIntent"> {
  /** Queue a painted cell (global-pixel coords). Buffered + co-signed as a run on your turn. */
  paint: (gx: number, gy: number, color: number) => void;
}

/** Flatten a global-pixel cell to a (chunk, in-chunk) move with its per-seat `seq`; floorDiv
 *  keeps x/y in-range for negative globals (the canvas extends in every direction). */
function toCellMove(
  gx: number,
  gy: number,
  color: number,
  seq: number,
): PvpCellMove {
  const cx = Math.floor(gx / CHUNK_SIZE);
  const cy = Math.floor(gy / CHUNK_SIZE);
  return {
    cx: BigInt(cx),
    cy: BigInt(cy),
    x: gx - cx * CHUNK_SIZE,
    y: gy - cy * CHUNK_SIZE,
    color,
    seq,
  };
}

export function usePvpWorldCanvas(windowId: string): PvpWorldCanvas {
  const { setIntent, ...rest } = usePvpMatch(windowId);
  const role = rest.role;
  const view = rest.view;
  const auto = rest.auto;

  // YOUR un-confirmed cells, FIFO. `paint` stamps each with a per-seat `seq` and queues the
  // buffer's head (capped at the batch limit) as the next move; the engine sends it on your
  // turn. Re-sending is now PARITY-SAFE — the protocol folds each cell at most once per seat by
  // `seq` — so the buffer can stay at-least-once and we never double-fold the digest.
  const pendingRef = useRef<PvpCellMove[]>([]);
  // Next per-seat seq to stamp. Monotonic; re-seeded above the seat's applied cursor so a paint
  // taken back from the bot continues the seat's seq line instead of replaying skipped numbers.
  const nextSeqRef = useRef(1);
  // High-water of MY confirmed per-seat seq. Monotonic and taken as a MAX over the view, so the
  // render cap (drops oldest) and eviction can never corrupt it — fixing the trim counter that
  // pegged at the cap before. Cells at/below it are on-chain and safe to drop from the buffer.
  const confirmedSeqRef = useRef(0);

  /** Hand the buffer's head to the engine as the next move (≤ batch cap, so propose never throws
   *  "illegal batch" and stalls the turn loop); empty buffer ⇒ an idle co-sign tick. */
  const flush = useCallback(() => {
    const head = pendingRef.current.slice(0, MAX_BATCH_CELLS);
    setIntent(head.length ? { cells: head } : IDLE_INTENT);
  }, [setIntent]);

  useEffect(() => {
    if (!role) {
      // Between matches: drop any stale buffer so a new match starts clean.
      pendingRef.current = [];
      nextSeqRef.current = 1;
      confirmedSeqRef.current = 0;
      return;
    }
    // Advance the confirmed high-water from MY cells in the view (incl. bot paints while Auto was
    // on), so we never re-stamp a seq the seat already folded.
    let myMax = confirmedSeqRef.current;
    for (const c of view ?? []) {
      if (c.by === role && c.pseq > myMax) myMax = c.pseq;
    }
    confirmedSeqRef.current = myMax;
    if (nextSeqRef.current <= myMax) nextSeqRef.current = myMax + 1;

    if (auto) {
      // The bot drives this seat; drop any stale manual buffer so it can't replay later as a
      // run of already-skipped seqs.
      pendingRef.current = [];
      return;
    }
    // Drop confirmed cells; re-sending the rest is a safe no-op, so this only bounds the buffer.
    pendingRef.current = pendingRef.current.filter((c) => c.seq > myMax);
    flush();
  }, [view, role, auto, flush]);

  const paint = useCallback(
    (gx: number, gy: number, color: number) => {
      const seq = nextSeqRef.current++;
      pendingRef.current.push(toCellMove(gx, gy, color, seq));
      flush();
    },
    [flush],
  );

  return { ...rest, paint };
}
