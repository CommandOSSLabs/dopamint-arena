/**
 * Massive activity generator (Deliverable 5).
 *
 * Drives an array of in-memory tunnels through signed state transitions as fast as
 * possible (flat-out) or at a configured target rate. Design for throughput:
 *  - synchronous tight loop (runSteps) for max per-core rate — no awaits, no allocs
 *    beyond what signing requires (the engine reuses a per-tunnel write buffer)
 *  - batched async loop (run) for duration limits, throttling, and periodic sampling,
 *    reading the clock once per batch (not per step)
 *  - per-tunnel strict ordering preserved (round-robin across independent tunnels);
 *    parallelism comes from tunnel count and worker shards, never concurrent steps
 *    on one tunnel (DESIGN_REVIEW B9)
 */

import { OffchainTunnel, SignMode } from "../core/tunnel";
import { Party, otherParty } from "../protocol/Protocol";
import { Counters, TimeSeries } from "../telemetry/metrics";
import { Rng } from "./rng";

export interface RunOptions {
  /** Stop after this much wall-clock time. */
  durationMs?: number;
  /** Stop after this many attempted steps (whichever limit hits first). */
  maxSteps?: number;
  /** Throttle to ~this many updates/sec; omit to run flat-out. */
  targetUpdatesPerSec?: number;
  /** Steps per synchronous slice between event-loop yields. Default 50_000. */
  batchSize?: number;
  /** Record a TimeSeries sample at least this often (ms). */
  sampleEveryMs?: number;
  series?: TimeSeries;
  /** Injectable clock for tests (default Date.now). */
  now?: () => number;
}

export class ActivityGenerator<S, M> {
  /** Coarse timestamp (ms) embedded in signed updates; refreshed once per batch. */
  private ts: bigint = 0n;
  /** Persistent proposer parity so `by` truly alternates across batches. */
  private seq = 0;
  private readonly sigsPerStep: number;
  private readonly verPerStep: number;

  constructor(
    private readonly tunnels: OffchainTunnel<S, M>[],
    private readonly counters: Counters,
    private readonly rng: Rng,
    private readonly signMode: SignMode = "full"
  ) {
    this.sigsPerStep = signMode === "none" ? 0 : 2;
    this.verPerStep = signMode === "full" ? 2 : 0;
  }

  setTimestamp(ms: bigint): void {
    this.ts = ms;
  }

  /**
   * Run exactly `totalSteps` synchronous steps starting at tunnel index `startAt`.
   * Returns the next start index (so successive batches keep round-robining).
   */
  runSteps(totalSteps: number, startAt = 0): number {
    const tunnels = this.tunnels;
    const n = tunnels.length;
    if (n === 0) return 0;
    const c = this.counters;
    const ts = this.ts;
    let idx = startAt % n;
    for (let i = 0; i < totalSteps; i++) {
      const t = tunnels[idx];
      if (t.protocol.randomMove) {
        // Proposer parity uses a round counter (this.seq, advanced once per full pass over
        // the tunnels — see below) plus the tunnel index. Advancing per ROUND rather than
        // per step makes each tunnel's proposer alternate on successive visits, so an even
        // tunnel count no longer pins every tunnel to a single direction. The fallback below
        // switches to the other party if the chosen one cannot move (forward progress).
        let by: Party = ((this.seq + idx) & 1) === 0 ? "A" : "B";
        let move = t.protocol.randomMove(t.state, by, this.rng);
        if (!move) {
          const alt = otherParty(by);
          const m2 = t.protocol.randomMove(t.state, alt, this.rng);
          if (m2) {
            by = alt;
            move = m2;
          }
        }
        if (move) {
          try {
            const r = t.step(move, by, { mode: this.signMode, timestamp: ts });
            c.updates++;
            c.signatures += this.sigsPerStep;
            c.verifications += this.verPerStep;
            c.bytes += r.messageBytes;
          } catch {
            c.errors++;
          }
        }
      }
      idx++;
      if (idx === n) {
        idx = 0;
        this.seq++; // next pass flips each tunnel's proposer
      }
    }
    return idx;
  }

  /**
   * Batched async run with optional duration/step caps, throttling, and sampling.
   * Resolves when a stop condition is met. Counters accumulate throughout.
   */
  async run(opts: RunOptions = {}): Promise<void> {
    const now = opts.now ?? Date.now;
    const batchSize = opts.batchSize ?? 50_000;
    const start = now();
    const series = opts.series;
    let lastSample = start;
    let startIdx = 0;
    let stagnant = 0;

    if (series) series.record(0, this.counters);

    for (;;) {
      const elapsed = now() - start;
      if (opts.durationMs !== undefined && elapsed >= opts.durationMs) break;
      if (
        opts.maxSteps !== undefined &&
        this.counters.updates >= opts.maxSteps
      ) {
        break;
      }

      // throttle: don't get ahead of the target rate
      if (opts.targetUpdatesPerSec !== undefined && elapsed > 0) {
        const allowed = (opts.targetUpdatesPerSec * elapsed) / 1000;
        if (this.counters.updates >= allowed) {
          await sleep(1);
          continue;
        }
      }

      this.ts = BigInt(start + elapsed);
      let steps = batchSize;
      if (opts.maxSteps !== undefined) {
        steps = Math.min(steps, opts.maxSteps - this.counters.updates);
      }
      const before = this.counters.updates;
      startIdx = this.runSteps(steps, startIdx);
      // Defensive: if a non-trivial batch makes zero progress repeatedly, stop
      // rather than spin forever (cannot happen with a positive total, but guard).
      if (steps > 0 && this.counters.updates === before) {
        if (++stagnant > 3) break;
      } else {
        stagnant = 0;
      }

      const t = now();
      if (
        series &&
        opts.sampleEveryMs &&
        t - lastSample >= opts.sampleEveryMs
      ) {
        series.record(t - start, this.counters);
        lastSample = t;
      }
      await yieldToLoop();
    }

    if (series) series.record(now() - start, this.counters);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function yieldToLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
