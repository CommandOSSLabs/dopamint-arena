import { test } from "node:test";
import assert from "node:assert";
import { createMetrics, recordLatency, startBucketEmitter } from "./pvpMetrics";

test("createMetrics returns zeroed structure", () => {
  const m = createMetrics();
  assert.strictEqual(m.actionsTotal, 0);
  assert.strictEqual(m.matchesCompleted, 0);
  assert.strictEqual(m.errors, 0);
  assert.deepStrictEqual(m.latencyHistogramMs, []);
  assert.deepStrictEqual(m.actionsPerSecond, []);
});

test("bucket emitter records deltas", async () => {
  const m = createMetrics();
  const buckets: number[] = [];
  const stop = startBucketEmitter(m, 50, (c) => buckets.push(c));
  m.actionsTotal += 3;
  await new Promise((r) => setTimeout(r, 70));
  m.actionsTotal += 2;
  await new Promise((r) => setTimeout(r, 70));
  stop();
  assert.strictEqual(buckets[0], 3);
  assert.strictEqual(buckets[1], 2);
});

test("recordLatency bounds histogram size", () => {
  const m = createMetrics();
  for (let i = 0; i < 12_000; i++) {
    recordLatency(m, i);
  }
  assert.strictEqual(m.latencyHistogramMs.length, 10_000);
});
