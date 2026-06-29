/** Compact tx/s formatter — k/M suffixes so a busy rate stays single-glance. Shared by the
 *  per-game window chip and the aggregate "Transactions / sec" panel. */
export function fmtTps(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}
