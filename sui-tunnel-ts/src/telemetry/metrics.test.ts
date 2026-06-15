import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newCounters,
  addInto,
  mergeCounters,
  rateReport,
  TimeSeries,
} from "./metrics";

test("addInto and mergeCounters sum shards", () => {
  const a = newCounters();
  a.updates = 100;
  a.signatures = 200;
  a.bytes = 12000;
  const b = newCounters();
  b.updates = 50;
  b.signatures = 100;
  b.bytes = 6000;
  const merged = mergeCounters([a, b]);
  assert.equal(merged.updates, 150);
  assert.equal(merged.signatures, 300);
  assert.equal(merged.bytes, 18000);
  // addInto mutates target
  addInto(a, b);
  assert.equal(a.updates, 150);
});

test("rateReport computes per-second rates and active tunnels", () => {
  const c = newCounters();
  c.updates = 2_000_000;
  c.signatures = 4_000_000;
  c.verifications = 4_000_000;
  c.bytes = 240_000_000;
  c.tunnelsOpened = 1000;
  c.tunnelsClosed = 100;
  const r = rateReport(c, 2000); // 2 seconds
  assert.equal(r.elapsedSec, 2);
  assert.equal(r.updatesPerSec, 1_000_000);
  assert.equal(r.signaturesPerSec, 2_000_000);
  assert.equal(r.bytesPerSec, 120_000_000);
  assert.equal(r.tunnelsActive, 900);
});

test("rateReport handles zero elapsed safely", () => {
  const r = rateReport(newCounters(), 0);
  assert.equal(r.updatesPerSec, 0);
});

test("TimeSeries peak updates/sec across samples", () => {
  const ts = new TimeSeries();
  const c = newCounters();
  ts.record(0, c);
  c.updates = 1000;
  ts.record(1000, c); // +1000 in 1s -> 1000/s
  c.updates = 4000;
  ts.record(2000, c); // +3000 in 1s -> 3000/s (peak)
  assert.equal(ts.peakUpdatesPerSec(), 3000);
  assert.equal(ts.all().length, 3);
});
