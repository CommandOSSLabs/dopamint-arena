/**
 * Resume adapter for World Canvas PvP: round-trips {@link PvpCanvasState} (and any
 * pending move) through localStorage so a cold reload re-syncs the match. The digest
 * is the co-signed truth (hex), cells are render-only, balances + the move's chunk
 * coords are bigints (decimal strings — localStorage can't hold bigints). No hidden
 * secret — the wall is fully public.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { JsonValue } from "@/pvp/resume";
import { worldCanvasMoveCodec } from "./pvpProtocol";
import type { PvpCanvasState, PvpPaintMove } from "./pvpProtocol";

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export function makeWorldCanvasPvpResumeAdapter(
  onReconciled?: ResumeAdapter<PvpCanvasState, PvpPaintMove>["onReconciled"],
): ResumeAdapter<PvpCanvasState, PvpPaintMove> {
  return {
    serializeState: (s) =>
      ({
        digest: toHex(s.digest),
        cells: s.cells,
        paintCount: s.paintCount,
        balanceA: s.balanceA.toString(),
        balanceB: s.balanceB.toString(),
        total: s.total.toString(),
      }) as unknown as JsonValue,
    deserializeState: (j) => {
      const o = j as Record<string, unknown>;
      return {
        digest: fromHex(o.digest as string),
        cells: (o.cells as PvpCanvasState["cells"]) ?? [],
        paintCount: (o.paintCount as number) ?? 0,
        winner: null,
        balanceA: BigInt(o.balanceA as string),
        balanceB: BigInt(o.balanceB as string),
        total: BigInt(o.total as string),
      };
    },
    // The move's chunk coords (cx/cy) are bigint; localStorage can't hold bigint, so a pending
    // move round-trips through the SAME codec the relay uses (decimal-string chunk coords).
    serializeMove: (m) => worldCanvasMoveCodec.encode(m) as JsonValue,
    deserializeMove: (j) => worldCanvasMoveCodec.decode(j),
    onReconciled: onReconciled ?? (() => {}),
  };
}
