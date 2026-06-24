import assert from "node:assert/strict";
import { test } from "node:test";
import { distribute, runCluster } from "./cluster";

test("distribute splits a total into near-equal parts", () => {
  assert.deepEqual(distribute(10, 3), [4, 3, 3]);
  assert.deepEqual(distribute(9, 3), [3, 3, 3]);
  assert.equal(
    distribute(1000, 7).reduce((a, b) => a + b, 0),
    1000
  );
  assert.deepEqual(distribute(0, 2), [0, 0]);
});

test("runCluster spawns workers and aggregates their shard counters", async () => {
  const res = await runCluster({
    workers: 2,
    tunnels: 8,
    users: 4,
    agents: 4,
    maxSteps: 2000,
    batchSize: 500,
    signMode: "full",
    seed: 1,
  });
  assert.equal(res.workers, 2);
  assert.equal(res.perShard.length, 2);
  // 2000 split across 2 workers => ~2000 verified updates aggregated
  assert.ok(res.report.updates >= 1900, `updates=${res.report.updates}`);
  assert.ok(res.report.updatesPerSec > 0);
  assert.ok(res.report.signaturesPerSec > 0);
});
