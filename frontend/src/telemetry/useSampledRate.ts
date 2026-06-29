import { useEffect, useRef, useState } from "react";

const SAMPLE_MS = 1000;

/**
 * Samples a monotonically-growing counter once a second into an instantaneous rate
 * (delta / dt). Returns null until the counter has moved, so callers can hide a metric
 * that has no real activity yet rather than show a fabricated zero. Shared by the per-game
 * window chip and the aggregate "Transactions / sec" panel so their numbers stay consistent
 * (the panel's total is the same source summed).
 */
export function useSampledRate(getTotal: () => number): number | null {
  const [rate, setRate] = useState<number | null>(null);
  const prev = useRef({ total: getTotal(), ms: Date.now() });

  useEffect(() => {
    prev.current = { total: getTotal(), ms: Date.now() };
    const id = setInterval(() => {
      const total = getTotal();
      const dt = Math.max(1, Date.now() - prev.current.ms) / 1000;
      const next = (total - prev.current.total) / dt;
      prev.current = { total, ms: Date.now() };
      setRate(total === 0 ? null : next);
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [getTotal]);

  return rate;
}
