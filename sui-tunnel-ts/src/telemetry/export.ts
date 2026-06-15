/**
 * Metrics export (Deliverable 6): JSON + CSV. Pure string producers with no I/O,
 * so they run anywhere (browser, worker, node) and the caller decides where bytes go.
 * The future webpage consumes these directly.
 */

import { RateReport, Sample, rateReport } from "./metrics";

/** Pretty JSON of a single rate report. */
export function reportToJSON(report: RateReport): string {
  return JSON.stringify(report, null, 2);
}

const CSV_COLUMNS: (keyof RateReport)[] = [
  "elapsedSec",
  "updates",
  "updatesPerSec",
  "signatures",
  "signaturesPerSec",
  "verifications",
  "verificationsPerSec",
  "bytes",
  "bytesPerSec",
  "tunnelsOpened",
  "tunnelsClosed",
  "tunnelsActive",
  "disputes",
  "settlements",
  "errors",
];

function csvRow(values: (string | number)[]): string {
  return values
    .map((v) => (typeof v === "number" ? formatNum(v) : v))
    .join(",");
}

function formatNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

/** CSV time series: one header + one row per sample (rates derived per interval). */
export function samplesToCSV(samples: readonly Sample[]): string {
  const lines: string[] = [csvRow(["tMs", ...CSV_COLUMNS])];
  let prevT = samples.length ? samples[0].tMs : 0;
  for (const s of samples) {
    const elapsed = s.tMs - prevT;
    const r = rateReport(s.counters, elapsed > 0 ? elapsed : 1);
    lines.push(csvRow([s.tMs, ...CSV_COLUMNS.map((k) => r[k] as number)]));
    prevT = s.tMs;
  }
  return lines.join("\n");
}

/** Single-row CSV (header + the final report). */
export function reportToCSV(report: RateReport): string {
  return [
    csvRow(CSV_COLUMNS),
    csvRow(CSV_COLUMNS.map((k) => report[k] as number)),
  ].join("\n");
}
