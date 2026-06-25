export interface ResourceSummary {
  cpu: { avgPct: number; peakPct: number; avgCores: number; peakCores: number };
  mem: { avgRssMb: number; peakRssMb: number };
  samples: number;
}

/** Pure aggregation. CPU% = cpu-time / wall-time * 100; cores = pct / 100. */
export function summarizeResources(
  startCpuUs: number,
  endCpuUs: number,
  elapsedMs: number,
  intervalPcts: number[],
  rssBytes: number[],
): ResourceSummary {
  const avgPct = elapsedMs > 0 ? ((endCpuUs - startCpuUs) / 1000 / elapsedMs) * 100 : 0;
  const peakPct = intervalPcts.length ? Math.max(...intervalPcts) : avgPct;
  const avgRss = rssBytes.length ? rssBytes.reduce((a, b) => a + b, 0) / rssBytes.length : 0;
  const peakRss = rssBytes.length ? Math.max(...rssBytes) : 0;
  return {
    cpu: { avgPct, peakPct, avgCores: avgPct / 100, peakCores: peakPct / 100 },
    mem: { avgRssMb: avgRss / 1048576, peakRssMb: peakRss / 1048576 },
    samples: rssBytes.length,
  };
}

const cpuUs = () => {
  const u = process.cpuUsage();
  return u.user + u.system; // microseconds, cumulative since process start (all threads)
};

/** Samples process-wide CPU + RSS on a timer until stop(). */
export function startResourceMonitor(opts: { intervalMs?: number } = {}): { stop(): ResourceSummary } {
  const intervalMs = opts.intervalMs ?? 500;
  const startCpu = cpuUs();
  const startT = performance.now();
  let lastCpu = startCpu;
  let lastT = startT;
  const intervalPcts: number[] = [];
  const rssBytes: number[] = [];
  const timer = setInterval(() => {
    const t = performance.now();
    const c = cpuUs();
    const dtMs = t - lastT;
    if (dtMs > 0) intervalPcts.push(((c - lastCpu) / 1000 / dtMs) * 100);
    rssBytes.push(process.memoryUsage().rss);
    lastT = t;
    lastCpu = c;
  }, intervalMs);
  return {
    stop(): ResourceSummary {
      clearInterval(timer);
      return summarizeResources(startCpu, cpuUs(), performance.now() - startT, intervalPcts, rssBytes);
    },
  };
}

export function formatResources(s: ResourceSummary): string {
  return `cpu avg=${s.cpu.avgCores.toFixed(1)} cores (${s.cpu.avgPct.toFixed(0)}%) peak=${s.cpu.peakCores.toFixed(1)} cores (${s.cpu.peakPct.toFixed(0)}%), rss avg=${s.mem.avgRssMb.toFixed(0)}MB peak=${s.mem.peakRssMb.toFixed(0)}MB, samples=${s.samples}`;
}
