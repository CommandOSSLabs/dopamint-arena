import { test, expect } from "bun:test";
import {
  aggregate,
  renderTable,
  renderMarkdown,
  reportBasename,
  type GameResult,
  type ReportMeta,
} from "./report";

const META: ReportMeta = {
  env: "feat-x",
  channel: "local",
  anchor: "offchain",
  workers: 12,
  concurrency: 2,
  totalCores: 8,
  durationSec: 10,
  packageId: "0xpkg",
  startedAtIso: "2026-06-25T13:45:30.123Z",
  resources: "cpu avg=6.0 cores, rss peak=900MB, samples=20",
};

const OK_A: GameResult = {
  game: "blackjack", status: "ok", workers: 12, matches: 200, moves: 6000, elapsedMs: 10_000,
  cpuUtilAvgPct: 83, cpuUtilPeakPct: 91,
};
const OK_B: GameResult = {
  game: "battleship", status: "ok", workers: 12, matches: 40, moves: 9000, elapsedMs: 10_000,
  cpuUtilAvgPct: 47, cpuUtilPeakPct: 60,
};
const FAILED: GameResult = {
  game: "cross", status: "failed", workers: 12, matches: 0, moves: 0, elapsedMs: 0,
  cpuUtilAvgPct: 0, cpuUtilPeakPct: 0, error: "boom",
};

test("aggregate sums ok games and tracks busiest + peak CPU utilization", () => {
  const agg = aggregate([OK_A, OK_B, FAILED]);
  expect(agg.okCount).toBe(2);
  expect(agg.failedCount).toBe(1);
  expect(agg.totalMoves).toBe(15000);
  expect(agg.totalMatches).toBe(240);
  expect(agg.totalElapsedMs).toBe(20_000);
  expect(agg.overallMovesPerSec).toBeCloseTo((15000 * 1000) / 20_000, 5);
  expect(agg.overallMatchesPerSec).toBeCloseTo((240 * 1000) / 20_000, 5);
  expect(agg.busiestAvgUtilPct).toBe(83); // max of per-game avg util
  expect(agg.peakUtilPct).toBe(91); // max of per-game peak util
});

test("aggregate over all-failed yields zeroed throughput and CPU, not NaN", () => {
  const agg = aggregate([FAILED]);
  expect(agg.okCount).toBe(0);
  expect(agg.totalMoves).toBe(0);
  expect(agg.overallMovesPerSec).toBe(0);
  expect(agg.busiestAvgUtilPct).toBe(0);
  expect(agg.peakUtilPct).toBe(0);
});

test("renderTable shows TPS, Matches/s, and CPU utilization percentages", () => {
  const out = renderTable([OK_A, FAILED], aggregate([OK_A, FAILED]));
  expect(out).toContain("blackjack");
  expect(out).toContain("FAILED");
  expect(out).toContain("boom");
  expect(out).toContain("TOTAL");
  expect(out).toContain("TPS (moves/s)");
  expect(out).toContain("CPU avg %");
  expect(out).toContain("CPU pk %");
  expect(out).toContain("83%"); // OK_A sustained utilization
});

test("renderMarkdown carries metadata, host cores, every game, and CPU utilization", () => {
  const md = renderMarkdown(META, [OK_A, OK_B, FAILED], aggregate([OK_A, OK_B, FAILED]));
  expect(md).toContain("# loadbench report");
  expect(md).toContain("local / offchain");
  expect(md).toContain("**CPU measured vs:** 8 cores (host)");
  expect(md).toContain("| blackjack |");
  expect(md).toContain("| battleship |");
  expect(md).toContain("| cross |");
  expect(md).toContain("## Aggregate");
  expect(md).toContain("2 ok, 1 failed");
  expect(md).toContain("Overall TPS (moves/s)");
  expect(md).toContain("Busiest CPU (sustained):** 83% of 8 cores");
  expect(md).toContain("Peak CPU (instantaneous):** 91% of 8 cores");
});

test("renderMarkdown labels the cap as time or matches", () => {
  expect(renderMarkdown(META, [OK_A], aggregate([OK_A]))).toContain("**Cap:** 10s per game");
  const counted = renderMarkdown({ ...META, durationSec: undefined, matches: 50 }, [OK_A], aggregate([OK_A]));
  expect(counted).toContain("**Cap:** 50 matches per game");
});

test("reportBasename is filesystem-safe and derived from env/channel/anchor/time", () => {
  expect(reportBasename(META)).toBe("bench-feat-x-local-offchain-20260625-134530.md");
  expect(reportBasename(META)).toMatch(/^bench-[a-z0-9-]+-(local|relay)-(onchain|offchain)-\d{8}-\d{6}\.md$/);
});
