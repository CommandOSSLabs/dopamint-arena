/**
 * Render-seq policy for a finalized live (in-progress) stroke — the seam that keeps a painter's
 * optimistic ink visible across the co-sign round-trip without breaking co-sign parity. Pure and
 * side-effect free so the decision can be unit-tested without a DOM/canvas.
 *
 * Solo: this seat's own cells never come back through `syncPaints` (the local painter is skipped
 * there), so its live stroke is the ONLY record — keep it pinned on top forever (`MAX_SAFE_INTEGER`).
 *
 * PvP: the painted/erased cells DO round-trip as co-signed cells carrying a real, strictly higher
 * render `seq`. Persist the optimistic stroke at a FINITE seq just above the applied cursor so it
 * shows the instant the pointer lifts (no flicker) yet still sits BELOW the next real co-signed
 * cell — which then overdraws it idempotently (same pos/color → invisible). Finite, not MAX, so a
 * later higher-seq repaint/erase from EITHER seat can still cover it. This is RENDER-ONLY: it never
 * folds a move, so the co-signed digest/per-seat cursor are untouched and both seats stay
 * byte-identical.
 */
export function liveStrokePersistSeq(
  isSolo: boolean,
  appliedSeq: number,
): number {
  return isSolo ? Number.MAX_SAFE_INTEGER : appliedSeq + 0.5;
}
