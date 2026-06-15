import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyCoSignedUpdate } from "../core/tunnel";
import { newCounters, rateReport } from "../telemetry/metrics";
import { ActivityGenerator } from "./activityGen";
import { Simulator } from "./engine";
import { mulberry32 } from "./rng";

test("runSteps produces the expected counters in full mode", () => {
  const sim = new Simulator({ users: 2, agents: 2, tunnels: 4 });
  const counters = newCounters();
  const gen = new ActivityGenerator(
    sim.tunnels,
    counters,
    mulberry32(7),
    "full",
  );
  gen.runSteps(1000);
  assert.equal(counters.updates, 1000);
  assert.equal(counters.signatures, 2000);
  assert.equal(counters.verifications, 2000);
  assert.equal(counters.bytes, 1000 * 120);
  assert.equal(counters.errors, 0);
});

test("REPRO #7: an even tunnel count exercises BOTH proposers on every tunnel", () => {
  const sim = new Simulator({ users: 2, agents: 2, tunnels: 4 }); // even count
  const counters = newCounters();
  // Record which party proposes on each tunnel by wrapping its protocol.randomMove.
  const seen = sim.tunnels.map(() => ({ A: 0, B: 0 }));
  sim.tunnels.forEach((t, ti) => {
    const orig = t.protocol;
    const spy = Object.create(orig);
    spy.randomMove = (state: unknown, by: "A" | "B", rng: unknown) => {
      seen[ti][by]++;
      return (
        orig.randomMove as (s: unknown, b: "A" | "B", r: unknown) => unknown
      )(state, by, rng);
    };
    (t as { protocol: unknown }).protocol = spy;
  });
  new ActivityGenerator(sim.tunnels, counters, mulberry32(7), "full").runSteps(
    400,
  );
  for (let i = 0; i < seen.length; i++) {
    // Previously each tunnel saw a single proposer (one of these was 0).
    assert.ok(
      seen[i].A > 0 && seen[i].B > 0,
      `tunnel ${i} must see both proposers, got ${JSON.stringify(seen[i])}`,
    );
  }
});

test("sign-only and none modes adjust signature/verification counts", () => {
  const sim = new Simulator({ users: 1, agents: 1, tunnels: 2 });
  const so = newCounters();
  new ActivityGenerator(sim.tunnels, so, mulberry32(1), "sign-only").runSteps(
    100,
  );
  assert.equal(so.updates, 100);
  assert.equal(so.signatures, 200);
  assert.equal(so.verifications, 0);

  const sim2 = new Simulator({ users: 1, agents: 1, tunnels: 2 });
  const none = newCounters();
  new ActivityGenerator(sim2.tunnels, none, mulberry32(1), "none").runSteps(
    100,
  );
  assert.equal(none.updates, 100);
  assert.equal(none.signatures, 0);
  assert.ok(none.bytes > 0);
});

test("updates remain settleable (latest co-signed update verifies)", () => {
  const sim = new Simulator({ users: 2, agents: 2, tunnels: 4 });
  const counters = newCounters();
  new ActivityGenerator(sim.tunnels, counters, mulberry32(3), "full").runSteps(
    400,
  );
  for (const t of sim.tunnels) {
    const u = t.latest!;
    assert.ok(
      verifyCoSignedUpdate(
        u,
        { publicKey: t.partyA.publicKey, scheme: t.partyA.scheme },
        { publicKey: t.partyB.publicKey, scheme: t.partyB.scheme },
      ),
    );
  }
});

test("async run respects duration and records a time series", async () => {
  const sim = new Simulator({ users: 2, agents: 2, tunnels: 8 });
  const counters = newCounters();
  const gen = new ActivityGenerator(
    sim.tunnels,
    counters,
    mulberry32(5),
    "full",
  );
  const { TimeSeries } = await import("../telemetry/metrics");
  const series = new TimeSeries();
  await gen.run({ durationMs: 60, batchSize: 100, sampleEveryMs: 10, series });
  assert.ok(counters.updates > 0);
  const r = rateReport(counters, 60);
  assert.ok(r.updatesPerSec > 0);
  assert.ok(series.all().length >= 2);
});

test("async run honors maxSteps exactly", async () => {
  const sim = new Simulator({ users: 1, agents: 1, tunnels: 2 });
  const counters = newCounters();
  const gen = new ActivityGenerator(
    sim.tunnels,
    counters,
    mulberry32(9),
    "full",
  );
  await gen.run({ maxSteps: 1000, batchSize: 250 });
  assert.equal(counters.updates, 1000);
});
