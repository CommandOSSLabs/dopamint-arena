/** Compact HUD counts: 999 → 999, 1200 → 1.2K, 1_500_000 → 1.5M. */
export function formatCompactCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${abs}`;
  if (abs < 1_000_000) return `${sign}${compactUnit(abs / 1000)}K`;
  if (abs < 1_000_000_000) return `${sign}${compactUnit(abs / 1_000_000)}M`;
  return `${sign}${compactUnit(abs / 1_000_000_000)}B`;
}

function compactUnit(value: number): string {
  if (value >= 100) return String(Math.round(value));
  const rounded = Math.round(value * 10) / 10;
  return rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1);
}
