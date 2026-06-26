import { test, expect } from "bun:test";
import { captureMatch, measureAblation } from "./ablation";

test("measureAblation yields additive buckets + residual + sub-measures", async () => {
  const cap = await captureMatch("blackjack");
  const r = measureAblation(cap, 3);

  expect(r.game).toBe("blackjack");
  expect(r.moves).toBe(cap.moves);

  const labels = r.buckets.map((b) => b.label);
  expect(labels).toEqual([
    "JSON envelope + move codec (encode+decode)",
    "crypto sign+verify (native hop)",
    "Promise/await wrapper (proposeAndAwait)",
  ]);
  for (const b of r.buckets) expect(b.nsPerMove).toBeGreaterThan(0);

  // attributed = sum of buckets; residual = budget - attributed (no double count)
  const sum = r.buckets.reduce((a, b) => a + b.nsPerMove, 0);
  expect(Math.abs(r.attributedNs - sum)).toBeLessThan(1e-6);
  expect(Math.abs(r.residualNs - (r.perMoveBudgetNs - r.attributedNs))).toBeLessThan(1e-6);

  const subLabels = r.subMeasures.map((s) => s.label);
  expect(subLabels).toContain("of which move codec (encode+decode)");
  expect(subLabels).toContain("bigint conversions+arithmetic vs number (isolated)");
  expect(subLabels).toContain("crypto native sign+verify");
  expect(subLabels).toContain("crypto noble sign+verify");
  expect(subLabels).toContain("GC pause (aggregate)");
});
