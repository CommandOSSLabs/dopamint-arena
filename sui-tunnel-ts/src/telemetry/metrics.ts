/**
 * Telemetry counters and rate reporting (Deliverable 6).
 *
 * The hot loop mutates a plain {@link Counters} object with bare integer
 * increments (no method-call or allocation overhead). Aggregation across worker
 * shards is a pure sum of counter objects. Rates are derived at report time so the
 * hot path never divides or reads the clock.
 */

export interface Counters {
  /** Fully co-signed (and, in full mode, verified) state transitions. */
  updates: number;
  /** Total signatures produced (≈ 2 per update in two-party mode). */
  signatures: number;
  /** Total signature verifications performed. */
  verifications: number;
  /** Serialized state-update message bytes produced. */
  bytes: number;
  tunnelsOpened: number;
  tunnelsClosed: number;
  disputes: number;
  settlements: number;
  errors: number;
}

export function newCounters(): Counters {
  return {
    updates: 0,
    signatures: 0,
    verifications: 0,
    bytes: 0,
    tunnelsOpened: 0,
    tunnelsClosed: 0,
    disputes: 0,
    settlements: 0,
    errors: 0,
  };
}

/** Add `src` into `target` in place (worker-shard aggregation). */
export function addInto(target: Counters, src: Counters): Counters {
  target.updates += src.updates;
  target.signatures += src.signatures;
  target.verifications += src.verifications;
  target.bytes += src.bytes;
  target.tunnelsOpened += src.tunnelsOpened;
  target.tunnelsClosed += src.tunnelsClosed;
  target.disputes += src.disputes;
  target.settlements += src.settlements;
  target.errors += src.errors;
  return target;
}

/** Sum many counter objects into a fresh one. */
export function mergeCounters(all: Counters[]): Counters {
  const out = newCounters();
  for (const c of all) addInto(out, c);
  return out;
}

export interface RateReport extends Counters {
  elapsedSec: number;
  updatesPerSec: number;
  signaturesPerSec: number;
  verificationsPerSec: number;
  bytesPerSec: number;
  /** Number of tunnels currently open (opened - closed). */
  tunnelsActive: number;
}

/** Compute a rate report from cumulative counters and elapsed wall time. */
export function rateReport(c: Counters, elapsedMs: number): RateReport {
  const sec = elapsedMs > 0 ? elapsedMs / 1000 : 0;
  const per = (n: number) => (sec > 0 ? n / sec : 0);
  return {
    ...c,
    elapsedSec: sec,
    updatesPerSec: per(c.updates),
    signaturesPerSec: per(c.signatures),
    verificationsPerSec: per(c.verifications),
    bytesPerSec: per(c.bytes),
    tunnelsActive: c.tunnelsOpened - c.tunnelsClosed,
  };
}

/**
 * A sampler that records periodic snapshots (cumulative counters + timestamp) so a
 * run can be exported as a time series for the dashboard / report.
 */
export interface Sample {
  tMs: number;
  counters: Counters;
}

export class TimeSeries {
  private readonly samples: Sample[] = [];

  /** Record a deep copy of the current counters at time `tMs`. */
  record(tMs: number, c: Counters): void {
    this.samples.push({ tMs, counters: { ...c } });
  }

  all(): readonly Sample[] {
    return this.samples;
  }

  /** Peak instantaneous updates/sec across consecutive samples. */
  peakUpdatesPerSec(): number {
    let peak = 0;
    for (let i = 1; i < this.samples.length; i++) {
      const prev = this.samples[i - 1];
      const cur = this.samples[i];
      const dt = (cur.tMs - prev.tMs) / 1000;
      if (dt <= 0) continue;
      const rate = (cur.counters.updates - prev.counters.updates) / dt;
      if (rate > peak) peak = rate;
    }
    return peak;
  }
}
