import { test, expect } from "bun:test";
import { parseSwarmArgs, runSwarm, resolveFleet, sliceMatches } from "./swarm";

test("parseSwarmArgs defaults: relay/onchain, workers+concurrency auto, all games", () => {
  const a = parseSwarmArgs([]);
  expect(a.channel).toBe("relay");
  expect(a.anchor).toBe("onchain");
  expect(a.workers).toBe("auto");
  expect(a.concurrency).toBe("auto");
});

test("parseSwarmArgs reads explicit workers/concurrency and budgets", () => {
  const a = parseSwarmArgs(["--workers", "8", "--concurrency", "32", "--mem-budget-mb", "4096", "--per-match-kb", "256"]);
  expect(a.workers).toBe(8);
  expect(a.concurrency).toBe(32);
  expect(a.memBudgetMb).toBe(4096);
  expect(a.perMatchKb).toBe(256);
});

test("resolveFleet io mode: workers = round(1.5*cores); concurrency memory-capped", () => {
  const r = resolveFleet(
    { workers: "auto", concurrency: "auto", memBudgetMb: null, perMatchKb: null },
    { cores: 8, totalMem: 8 * 1024 * 1024 * 1024 },
    "io",
  );
  expect(r.workers).toBe(12); // round(8 * 1.5)
  const maxInFlight = Math.floor((0.7 * 8 * 1024 * 1024 * 1024) / (512 * 1024));
  expect(r.concurrency).toBe(Math.max(1, Math.floor(maxInFlight / 12)));
});

test("resolveFleet cpu mode: concurrency is the low CPU-bound constant", () => {
  const r = resolveFleet(
    { workers: "auto", concurrency: "auto", memBudgetMb: null, perMatchKb: null },
    { cores: 10, totalMem: 8 * 1024 * 1024 * 1024 },
    "cpu",
  );
  expect(r.workers).toBe(15); // round(10 * 1.5)
  expect(r.concurrency).toBe(2);
});

test("resolveFleet respects explicit values regardless of mode", () => {
  const r = resolveFleet(
    { workers: 4, concurrency: 10, memBudgetMb: null, perMatchKb: null },
    { cores: 64, totalMem: 999 },
    "cpu",
  );
  expect(r).toEqual({ workers: 4, concurrency: 10 });
});

test("resolveFleet io mode uses an explicit memory budget for the cap", () => {
  const r = resolveFleet(
    { workers: 4, concurrency: "auto", memBudgetMb: 1024, perMatchKb: 512 },
    { cores: 99, totalMem: 1 },
    "io",
  );
  const maxInFlight = Math.floor((1024 * 1_048_576) / (512 * 1024));
  expect(r.workers).toBe(4);
  expect(r.concurrency).toBe(Math.max(1, Math.floor(maxInFlight / 4)));
});

test("sliceMatches distributes a cap across workers and sums to the total", () => {
  expect(sliceMatches(20, 4)).toEqual([5, 5, 5, 5]);
  expect(sliceMatches(21, 4)).toEqual([6, 6, 6, 3]);
  const s = sliceMatches(3, 4);
  expect(s.reduce((a, b) => a + b, 0)).toBe(3);
  expect(s.length).toBe(4);
});

test("runSwarm stops at the matches cap", async () => {
  const res = await runSwarm(async () => ({ moves: 5 }), {
    concurrency: 4,
    matches: 20,
    durationMs: null,
    now: () => 0,
  });
  expect(res.matches).toBe(20);
  expect(res.moves).toBe(100);
});

test("runSwarm stops when duration elapses", async () => {
  let t = 0;
  const res = await runSwarm(async () => { t += 10; return { moves: 1 }; }, {
    concurrency: 1,
    matches: null,
    durationMs: 50,
    now: () => t,
  });
  expect(res.elapsedMs).toBeGreaterThanOrEqual(50);
});
