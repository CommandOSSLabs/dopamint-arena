import { test, expect } from "bun:test";
import { percentile, summarize, ratePerSec } from "./metrics";

test("percentile picks the nearest-rank value", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  expect(percentile(xs, 50)).toBe(5);
  expect(percentile(xs, 99)).toBe(10);
});

test("summarize reports p50/p99 and count from unsorted input", () => {
  const s = summarize([10, 1, 5, 2, 9, 3, 8, 4, 7, 6]);
  expect(s.count).toBe(10);
  expect(s.p50).toBe(5);
  expect(s.p99).toBe(10);
});

test("ratePerSec divides count by elapsed seconds", () => {
  expect(ratePerSec(300, 1500)).toBeCloseTo(200, 5);
});
