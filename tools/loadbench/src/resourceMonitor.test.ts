import { test, expect } from "bun:test";
import { summarizeResources } from "./resourceMonitor";

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
