/**
 * Metrics for the PvP load generator: counters and a throughput histogram.
 */
export interface PvpMetrics {
  actionsTotal: number;
  matchesCompleted: number;
  errors: number;
  latencyHistogramMs: number[];
  actionsPerSecond: number[];
}

export function createMetrics(): PvpMetrics {
  return {
    actionsTotal: 0,
    matchesCompleted: 0,
    errors: 0,
    latencyHistogramMs: [],
    actionsPerSecond: [],
  };
}

export function startBucketEmitter(
  metrics: PvpMetrics,
  intervalMs: number,
  onBucket: (count: number) => void
): () => void {
  let last = metrics.actionsTotal;
  const timer = setInterval(() => {
    const current = metrics.actionsTotal;
    const delta = current - last;
    last = current;
    metrics.actionsPerSecond.push(delta);
    onBucket(delta);
  }, intervalMs);
  return () => clearInterval(timer);
}

const MAX_LATENCY_SAMPLES = 10_000;

/**
 * Record a latency sample while keeping the histogram bounded. Uses reservoir
 * sampling so older samples are gradually replaced once the cap is reached.
 */
export function recordLatency(metrics: PvpMetrics, latencyMs: number) {
  const arr = metrics.latencyHistogramMs;
  if (arr.length < MAX_LATENCY_SAMPLES) {
    arr.push(latencyMs);
  } else {
    const idx = Math.floor(Math.random() * (arr.length + 1));
    if (idx < arr.length) {
      arr[idx] = latencyMs;
    }
  }
}
