import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReport, runBenchmark } from "./harness";

test("runBenchmark produces a complete report from a small cluster run", async () => {
  const rep = await runBenchmark({
    agents: 8,
    tunnels: 16,
    workers: 2,
    maxSteps: 4000,
    batchSize: 1000,
    signMode: "full",
    seed: 1,
    settlementSample: 8,
  });
  assert.equal(rep.workers, 2);
  assert.equal(rep.tunnels, 16);
  assert.ok(
    rep.totalInteractions >= 3500,
    `interactions=${rep.totalInteractions}`
  );
  assert.ok(rep.avgTps > 0);
  assert.ok(rep.peakTps > 0);
  assert.ok(rep.signaturesPerSec > 0);
  // full mode => 2 sigs + 2 verifies per update
  assert.ok(rep.signaturesPerSec >= rep.avgTps * 1.5);
  assert.equal(rep.settlementSuccessRate, 1);
  assert.ok(rep.bytesPerUpdate > 0);
  assert.ok(formatReport(rep).includes("effective TPS"));
});

test("sign-only mode reports no verifications", async () => {
  const rep = await runBenchmark({
    agents: 4,
    tunnels: 8,
    workers: 2,
    maxSteps: 2000,
    batchSize: 500,
    signMode: "sign-only",
    seed: 2,
    settlementSample: 4,
  });
  assert.equal(rep.verificationsPerSec, 0);
  assert.ok(rep.signaturesPerSec > 0);
});
