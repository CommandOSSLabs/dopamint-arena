/**
 * Resume adapter for World Canvas PvP: round-trips {@link PvpCanvasState} through localStorage
 * so a cold reload re-syncs the match. The digest is the co-signed truth (hex), cells are
 * render-only, and the balances are bigints (decimal strings — localStorage can't hold bigints).
 * The pending move is JSON-native (number chunk coords), so it needs no (de)serializer — the
 * resume layer's default identity pass-through carries it. No hidden secret — the wall is public.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { JsonValue } from "@/pvp/resume";
import type {
  PvpCanvasState,
  PvpPaintMove,
} from "sui-tunnel-ts/protocol/worldCanvasPvp";

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
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
    // The pending move is JSON-native (a batch of number-coord cells), so serializeMove/
    // deserializeMove are omitted — the resume layer's default identity pass-through carries it.
    onReconciled: onReconciled ?? (() => {}),
  };
}
