import os from "node:os";
import { readFileSync } from "node:fs";

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
  rssBytes.push(process.memoryUsage().rss);
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


// ── System CPU utilization ───────────────────────────────────────────────────
// Unlike the process metric above (bench cpu-time / wall = "cores used"), this is
// how busy the machine's cores actually are: busy-time / (busy + idle) across all
// cores, from the OS scheduler's accounting. It captures every process on the box
// (e.g. the localnet container), so it answers "are the cores maxed out?".

export interface CpuTimesSnapshot {
  busy: number;
  total: number;
}

/** Sum busy and total CPU time (ms-equivalent ticks) across every core, right now. */
export function sampleCpuTimes(): CpuTimesSnapshot {
  let busy = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    const all = t.user + t.nice + t.sys + t.idle + t.irq;
    busy += all - t.idle;
    total += all;
  }
  return { busy, total };
}

/** System CPU utilization percentage over the window between two snapshots. */
export function cpuUtilPct(start: CpuTimesSnapshot, end: CpuTimesSnapshot): number {
  const dTotal = end.total - start.total;
  return dTotal > 0 ? ((end.busy - start.busy) / dTotal) * 100 : 0;
}

export interface SystemCpuSummary {
  utilAvgPct: number;
  utilPeakPct: number;
  samples: number;
}

/** Samples system-wide CPU utilization on a timer; avg over the whole window, peak interval. */
export function startSystemCpuMonitor(opts: { intervalMs?: number } = {}): { stop(): SystemCpuSummary } {
  const intervalMs = opts.intervalMs ?? 250;
  const start = sampleCpuTimes();
  let last = start;
  let peak = 0;
  let samples = 0;
  const timer = setInterval(() => {
    const cur = sampleCpuTimes();
    const u = cpuUtilPct(last, cur);
    if (cur.total - last.total > 0) {
      peak = Math.max(peak, u);
      samples++;
    }
    last = cur;
  }, intervalMs);
  return {
    stop(): SystemCpuSummary {
      clearInterval(timer);
      const utilAvgPct = cpuUtilPct(start, sampleCpuTimes());
      return { utilAvgPct, utilPeakPct: samples ? Math.max(peak, utilAvgPct) : utilAvgPct, samples };
    },
  };
}

// ── Container-aware CPU utilization ──────────────────────────────────────────
// Inside a `--cpus N` container, /proc/stat (what os.cpus() reads) still reports
// host-wide stats, so system utilization would be measured against all host
// cores, not the N assigned to the container. The cgroup knows the truth: it
// accounts the container's own CPU time and its quota. So when a quota is set we
// measure cpu-time-consumed / (wall * assignedCores); otherwise we fall back to
// host-wide system utilization. Either way the % answers "how busy are the cores
// assigned to the benchmark?".

/** Parse cgroup v2 `cpu.max` ("<quota> <period>" or "max <period>") into assigned cores, or null if unlimited. */
export function parseCgroupV2Quota(cpuMax: string): number | null {
  const [quota, period] = cpuMax.trim().split(/\s+/);
  if (!quota || quota === "max") return null;
  const q = Number(quota);
  const p = Number(period);
  return p > 0 && q > 0 ? q / p : null;
}

/** Cores assigned by the cgroup CPU quota (v2 then v1), or null if unlimited / not in a cgroup. */
function readCgroupQuotaCores(): number | null {
  try {
    return parseCgroupV2Quota(readFileSync("/sys/fs/cgroup/cpu.max", "utf8"));
  } catch {
    /* not cgroup v2 */
  }
  try {
    const q = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8").trim());
    const p = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8").trim());
    return q > 0 && p > 0 ? q / p : null;
  } catch {
    return null;
  }
}

/** Cumulative CPU time used by this cgroup, in microseconds (v2 then v1), or null. */
function readCgroupCpuUsec(): number | null {
  try {
    const m = readFileSync("/sys/fs/cgroup/cpu.stat", "utf8").match(/usage_usec\s+(\d+)/);
    if (m) return Number(m[1]);
  } catch {
    /* not cgroup v2 */
  }
  try {
    const ns = Number(readFileSync("/sys/fs/cgroup/cpuacct/cpuacct.usage", "utf8").trim());
    if (Number.isFinite(ns)) return ns / 1000;
  } catch {
    /* not cgroup v1 */
  }
  return null;
}

/** Cores the benchmark may use, and how it's measured: the cgroup quota in a
 *  capped container, else the host core count. */
export function cpuBudget(): { cores: number; basis: "cgroup" | "system" } {
  const quota = readCgroupQuotaCores();
  if (quota !== null && quota > 0 && readCgroupCpuUsec() !== null) return { cores: quota, basis: "cgroup" };
  return { cores: os.availableParallelism?.() ?? os.cpus().length, basis: "system" };
}

export interface CpuUtilSummary {
  utilAvgPct: number;
  utilPeakPct: number;
  samples: number;
  basis: "cgroup" | "system";
  assignedCores: number;
}

/** Utilization of the cores assigned to the benchmark: cgroup-accurate inside a
 *  capped container, host-wide otherwise. */
export function startCpuUtilMonitor(opts: { intervalMs?: number } = {}): { stop(): CpuUtilSummary } {
  const budget = cpuBudget();
  if (budget.basis === "system") {
    const m = startSystemCpuMonitor(opts);
    return { stop: () => ({ ...m.stop(), basis: "system", assignedCores: budget.cores }) };
  }
  // cgroup: utilization = cpu-time-consumed / (wall * assigned cores).
  const intervalMs = opts.intervalMs ?? 250;
  const startUsec = readCgroupCpuUsec()!;
  const startWall = performance.now();
  let lastUsec = startUsec;
  let lastWall = startWall;
  let peak = 0;
  let samples = 0;
  const timer = setInterval(() => {
    const u = readCgroupCpuUsec();
    const w = performance.now();
    if (u !== null && w - lastWall > 0) {
      const util = ((u - lastUsec) / 1000 / ((w - lastWall) * budget.cores)) * 100;
      peak = Math.max(peak, util);
      samples++;
      lastUsec = u;
      lastWall = w;
    }
  }, intervalMs);
  return {
    stop(): CpuUtilSummary {
      clearInterval(timer);
      const endUsec = readCgroupCpuUsec() ?? lastUsec;
      const dWall = performance.now() - startWall;
      const utilAvgPct = dWall > 0 ? ((endUsec - startUsec) / 1000 / (dWall * budget.cores)) * 100 : 0;
      return {
        utilAvgPct,
        utilPeakPct: samples ? Math.max(peak, utilAvgPct) : utilAvgPct,
        samples,
        basis: "cgroup",
        assignedCores: budget.cores,
      };
    },
  };
}
