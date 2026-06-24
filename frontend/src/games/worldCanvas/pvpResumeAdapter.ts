/**
 * Resume adapter for World Canvas PvP: round-trips {@link PvpCanvasState} (and any
 * pending move) through localStorage so a cold reload re-syncs the match. The digest
 * is the co-signed truth (hex), cells are render-only, balances + the move's chunk
 * coords are bigints (decimal strings — localStorage can't hold bigints). No hidden
 * secret — the wall is fully public.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { JsonValue } from "@/pvp/resume";
import { worldCanvasPvpMoveCodec } from "./pvpProtocol";
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
        // The per-seat idempotency cursor: persisted so a resumed seat keeps skipping cells it
        // already folded (it isn't recoverable from the digest alone).
        appliedSeqA: s.appliedSeqA,
        appliedSeqB: s.appliedSeqB,
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
        appliedSeqA: (o.appliedSeqA as number) ?? 0,
        appliedSeqB: (o.appliedSeqB as number) ?? 0,
        winner: null,
        balanceA: BigInt(o.balanceA as string),
        balanceB: BigInt(o.balanceB as string),
        total: BigInt(o.total as string),
      };
    },
    // A pending move is a batch of cells whose chunk coords (cx/cy) are bigint; localStorage
    // can't hold bigint, so it round-trips through the SAME batch codec the relay uses.
    serializeMove: (m) => worldCanvasPvpMoveCodec.encode(m) as JsonValue,
    deserializeMove: (j) => worldCanvasPvpMoveCodec.decode(j),
    onReconciled: onReconciled ?? (() => {}),
  };
}
