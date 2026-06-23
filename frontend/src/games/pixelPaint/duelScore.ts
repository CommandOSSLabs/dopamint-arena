/**
 * Pixel Duel scoring. A duel side is scored against its SECRET target stencil:
 * a cell counts as `correct` when the canvas painted there matches the target
 * color, and the target actually wants a color there (target[i] !== 0 — empty
 * "don't-care" cells never count). `total` is the number of wanted cells, and
 * `pct` is the fraction filled correctly in [0,1].
 *
 * Pure and deterministic — the duel hook calls this at reveal for each side and
 * the higher `pct` wins. Kept import-free so the score logic can be unit-tested
 * in isolation from React and the protocol.
 */

export interface DuelSideScore {
  /** Cells where canvas[i] === target[i] and the target wants a color there. */
  correct: number;
  /** Cells the target wants painted (target[i] !== 0). */
  total: number;
  /** correct / total in [0,1]; 0 when the target wants nothing. */
  pct: number;
}

/**
 * Score one side's `canvas` against its `target` stencil. Both arrays are
 * row-major and MUST be the same length (the projected stencil covers the whole
 * board); a length mismatch is a programming error and throws.
 */
export function scoreDuel(
  canvas: Uint8Array,
  target: Uint8Array,
): DuelSideScore {
  if (canvas.length !== target.length) {
    throw new Error(
      `scoreDuel length mismatch: canvas ${canvas.length} vs target ${target.length}`,
    );
  }
  let correct = 0;
  let total = 0;
  for (let i = 0; i < target.length; i++) {
    const want = target[i];
    if (want === 0) continue; // don't-care cell
    total++;
    if (canvas[i] === want) correct++;
  }
  return { correct, total, pct: total === 0 ? 0 : correct / total };
}

/**
 * Fog-of-war scoring. A seat's achievable completion is the fraction of its
 * SECRET target cells it has actually painted in its own seat color AND that the
 * enemy has NOT blocked. A cell the enemy revealed-and-hit (`blocked[i] === 1`)
 * can never count for its target owner, so it is excluded from both `correct`
 * and — to keep the percentage honest about what's still winnable — from
 * `total`. The achievable denominator therefore shrinks as the enemy lands hits:
 *
 *   pct = count(target wants this cell, canvas painted seat color, not blocked)
 *       / count(target wants this cell, not blocked)
 *
 * Pure and deterministic; the duel hook calls this per side at reveal and the
 * higher `pct` wins. All three arrays are row-major and MUST share a length.
 *
 * @param canvas  the live board (palette index per cell; 0 = empty).
 * @param target  this seat's secret stencil (0 = don't-care, else the seat color).
 * @param blocked 1 where the enemy has blocked the cell for its target owner.
 */
export function scoreDuelFog(
  canvas: Uint8Array,
  target: Uint8Array,
  blocked: Uint8Array,
): DuelSideScore {
  if (canvas.length !== target.length || canvas.length !== blocked.length) {
    throw new Error(
      `scoreDuelFog length mismatch: canvas ${canvas.length} vs target ${target.length} vs blocked ${blocked.length}`,
    );
  }
  let correct = 0;
  let total = 0;
  for (let i = 0; i < target.length; i++) {
    const want = target[i];
    if (want === 0) continue; // don't-care cell
    if (blocked[i]) continue; // enemy-blocked: unwinnable, drops from the goal
    total++;
    if (canvas[i] === want) correct++;
  }
  return { correct, total, pct: total === 0 ? 0 : correct / total };
}
