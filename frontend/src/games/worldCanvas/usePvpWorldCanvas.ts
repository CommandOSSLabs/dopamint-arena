/**
 * Online PvP for World Canvas: two real humans matched over the relay co-sign ONE
 * genuine 2-party tunnel and co-draw a shared canvas. Built on the shared, proven
 * {@link createPvpMatchHook} engine (matchmaking → fund → propose/ack co-sign → settle),
 * specialized only by the {@link WorldCanvasPvpProtocol} (rolling-digest co-sign + a
 * render-only cell list) and a paint intent. Turn-based at the channel level (the seats
 * co-sign alternately), so each side steers WHERE it paints; with Auto on, both seats
 * are bot-driven (genuine bot-vs-bot over the relay).
 *
 * The paint move carries BIGINT chunk indices (`cx`/`cy`), so the tunnel is built with
 * {@link worldCanvasMoveCodec} (the JSON relay can't carry bigint) — that is what lets the
 * opponent receive intact coordinates and render the same cell on their wall.
 */
import {
  createPvpMatchHook,
  type PvpMatch,
  type PvpStatus,
} from "@/pvp/pvpMatchHook";
import type { Role } from "@/pvp/mpClient";
import {
  WorldCanvasPvpProtocol,
  worldCanvasMoveCodec,
  CHUNK_SIZE,
  type PvpCanvasState,
  type PvpCell,
  type PvpPaintMove,
} from "./pvpProtocol";
import { makeWorldCanvasPvpResumeAdapter } from "./pvpResumeAdapter";

/** A seat's queued paint == the co-signed move (chunk index + in-chunk cell + palette). */
export type PaintIntent = PvpPaintMove;

/** Default when no human paint is pending (the origin cell, in Sui blue). */
const IDLE_INTENT: PaintIntent = { cx: 0n, cy: 0n, x: 0, y: 0, color: 13 };

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
  stepMs: 120,
  stake: 1n, // 1 MIST per seat — free/draw, never shifts (each human funds its own seat)
  makeProtocol: () => new WorldCanvasPvpProtocol(),
  // Chunk coords (cx/cy) are bigint; the JSON relay can't carry bigint, so the tunnel must
  // (de)serialize moves through this codec — otherwise the opponent decodes undefined coords.
  moveCodec: worldCanvasMoveCodec,
  deriveView: (s) => s.cells,
  makeResumeAdapter: makeWorldCanvasPvpResumeAdapter,
  idleIntent: IDLE_INTENT,
  intentToMove,
  readIntent,
});

export type { PvpStatus };

export interface PvpWorldCanvas
  extends Omit<PvpMatch<PvpCanvasState, PaintIntent, PvpCell[]>, "setIntent"> {
  /** Queue this seat's next paint (placed on its next co-signed turn). */
  paint: (gx: number, gy: number, color: number) => void;
}

/** Floor-divide that works for negative globals (the chunk of a global-pixel cell). */
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

export function usePvpWorldCanvas(windowId: string): PvpWorldCanvas {
  const { setIntent, ...rest } = usePvpMatch(windowId);
  return {
    ...rest,
    paint: (gx, gy, color) => {
      // The UI paints in global-pixel coords; the co-signed move is (chunk, in-chunk).
      // Split here so the wire move carries bigint chunk indices (infinite canvas), which
      // the codec serializes losslessly — applyMove flattens them back for rendering.
      const cx = floorDiv(gx, CHUNK_SIZE);
      const cy = floorDiv(gy, CHUNK_SIZE);
      setIntent({
        cx: BigInt(cx),
        cy: BigInt(cy),
        x: gx - cx * CHUNK_SIZE,
        y: gy - cy * CHUNK_SIZE,
        color,
      });
    },
  };
}
