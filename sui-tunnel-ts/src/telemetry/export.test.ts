import { test } from "node:test";
import assert from "node:assert/strict";
import { newCounters, rateReport, TimeSeries } from "./metrics";
import { reportToJSON, reportToCSV, samplesToCSV } from "./export";

function sampleCounters() {
  const c = newCounters();
  c.updates = 1_000_000;
  c.signatures = 2_000_000;
  c.verifications = 2_000_000;
  c.bytes = 120_000_000;
  c.tunnelsOpened = 1000;
  return c;
}

test("reportToJSON round-trips numeric fields", () => {
  const r = rateReport(sampleCounters(), 1000);
  const parsed = JSON.parse(reportToJSON(r));
  assert.equal(parsed.updates, 1_000_000);
  assert.equal(parsed.updatesPerSec, 1_000_000);
  assert.equal(parsed.tunnelsActive, 1000);
});

test("reportToCSV has a header and one data row", () => {
  const csv = reportToCSV(rateReport(sampleCounters(), 1000));
  const lines = csv.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("updatesPerSec"));
  assert.ok(lines[1].includes("1000000"));
});

test("samplesToCSV emits a row per sample", () => {
  const ts = new TimeSeries();
  const c = newCounters();
  ts.record(0, c);
  c.updates = 500;
  ts.record(1000, c);
  c.updates = 1500;
  ts.record(2000, c);
  const csv = samplesToCSV(ts.all());
  const lines = csv.split("\n");
  assert.equal(lines.length, 4); // header + 3 samples
  assert.ok(lines[0].startsWith("tMs,"));
});
