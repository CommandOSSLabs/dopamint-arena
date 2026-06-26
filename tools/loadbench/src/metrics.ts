/** Nearest-rank percentile over an UNSORTED copy. `p` in [0,100]. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarize(latenciesMs: number[]): { p50: number; p99: number; count: number } {
  return { p50: percentile(latenciesMs, 50), p99: percentile(latenciesMs, 99), count: latenciesMs.length };
}

export function ratePerSec(count: number, elapsedMs: number): number {
  return elapsedMs <= 0 ? 0 : (count * 1000) / elapsedMs;
}
