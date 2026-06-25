import { test, expect } from "bun:test";
import { summarizeResources, startResourceMonitor, cpuUtilPct, parseCgroupV2Quota } from "./resourceMonitor";

test("parseCgroupV2Quota reads assigned cores from cpu.max, null when unlimited", () => {
  expect(parseCgroupV2Quota("800000 100000")).toBe(8); // --cpus 8
  expect(parseCgroupV2Quota("250000 100000")).toBe(2.5);
  expect(parseCgroupV2Quota("max 100000")).toBeNull();
  expect(parseCgroupV2Quota("  150000   100000  ")).toBeCloseTo(1.5, 5);
});

test("cpuUtilPct is busy-time over total-time between two snapshots", () => {
  // 80 of 100 ticks busy across the window → 80% utilization.
  expect(cpuUtilPct({ busy: 0, total: 0 }, { busy: 80, total: 100 })).toBe(80);
  // fully idle window → 0%; no time elapsed → 0% (no divide-by-zero).
  expect(cpuUtilPct({ busy: 50, total: 100 }, { busy: 50, total: 200 })).toBe(0);
  expect(cpuUtilPct({ busy: 5, total: 10 }, { busy: 5, total: 10 })).toBe(0);
});

test("summarizeResources computes avg from total cpu-time and peak from intervals", () => {
  // 4 cpu-seconds over 1 wall-second => 400% avg => 4 cores.
  const s = summarizeResources(0, 4_000_000, 1000, [150, 400, 250], [100 * 1048576, 200 * 1048576]);
  expect(s.cpu.avgPct).toBeCloseTo(400, 5);
  expect(s.cpu.avgCores).toBeCloseTo(4, 5);
  expect(s.cpu.peakPct).toBe(400);
  expect(s.cpu.peakCores).toBeCloseTo(4, 5);
  expect(s.mem.avgRssMb).toBeCloseTo(150, 5);
  expect(s.mem.peakRssMb).toBeCloseTo(200, 5);
  expect(s.samples).toBe(2);
});

test("summarizeResources is safe with no samples", () => {
  const s = summarizeResources(0, 0, 0, [], []);
  expect(s.cpu.avgPct).toBe(0);
  expect(s.mem.peakRssMb).toBe(0);
  expect(s.samples).toBe(0);
});

test("startResourceMonitor captures at least one sample even on a sub-interval run", () => {
  const h = startResourceMonitor({ intervalMs: 10_000 }); // interval longer than the run
  const s = h.stop();
  expect(s.samples).toBeGreaterThanOrEqual(1);
  expect(s.mem.peakRssMb).toBeGreaterThan(0);
});
