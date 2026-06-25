/**
 * Benchmark harness (Deliverable 10): reproducible runs producing a full report —
 * total interactions, peak/avg effective TPS, signatures/sec, bandwidth, settlement
 * success rate, and per-core scaling.
 *
 * Throughput is measured on the multi-core cluster (sim/cluster.ts); peak TPS comes from
 * sampled aggregate progress. Settlement success is measured in-process on a sample (the
 * cluster's per-tunnel artifacts live in worker processes), by building + independently
 * verifying cooperative settlements. "Effective TPS" = fully dual-signed, receiver-verified
 * state transitions per second aggregated across workers (the honest definition).
 */

import os from "node:os";
import { AgentSwarm } from "../agents/Agent";
import { BehaviorName } from "../agents/behaviors";
import { runCluster } from "../sim/cluster";

export interface BenchConfig {
  agents: number;
  tunnels: number;
  /** Worker threads. Default max(1, cores-1). */
  workers?: number;
  /** Run for this long... */
  durationMs?: number;
  /** ...or cap total updates (whichever is set). */
  maxSteps?: number;
  /** Convenience: maxSteps = tunnels * updatesPerTunnel. */
  updatesPerTunnel?: number;
  /** "full" (dual sign + verify, the honest metric), "sign-only", or "none". */
  signMode?: "full" | "sign-only" | "none";
  /** Mixed agent behaviors; omit for the payments max-throughput workload. */
  behaviors?: BehaviorName[];
  initialBalance?: bigint;
  seed?: number;
  batchSize?: number;
  /** Tunnels to settle in-process for the success-rate measure. Default 50. */
  settlementSample?: number;
  /** Inject a clock for tests (default Date.now). */
  now?: () => number;
}

export interface BenchReport {
  cores: number;
  workers: number;
  signMode: string;
  behaviors: string[];
  tunnels: number;
  activeParticipants: number;
  elapsedMs: number;
  totalInteractions: number;
  avgTps: number;
  peakTps: number;
  perCoreTps: number;
  signaturesPerSec: number;
  verificationsPerSec: number;
  bytesPerSec: number;
  bandwidthBytes: number;
  bytesPerUpdate: number;
  settlementSuccessRate: number;
}

export async function runBenchmark(cfg: BenchConfig): Promise<BenchReport> {
  const now = cfg.now ?? Date.now;
  const cores = os.cpus().length;
  const workers = Math.max(1, cfg.workers ?? Math.max(1, cores - 1));
  const signMode = cfg.signMode ?? "full";
  const maxSteps =
    cfg.maxSteps ??
    (cfg.updatesPerTunnel ? cfg.tunnels * cfg.updatesPerTunnel : undefined);

  // --- throughput via the cluster, sampling aggregate progress for peak TPS ---
  let peakTps = 0;
  let lastUpdates = 0;
  let lastT = 0;
  const start = now();
  const res = await runCluster({
    workers,
    tunnels: cfg.tunnels,
    users: 0,
    agents: cfg.agents,
    behaviors: cfg.behaviors,
    initialBalance: cfg.initialBalance,
    signMode,
    durationMs: cfg.durationMs,
    maxSteps,
    batchSize: cfg.batchSize,
    seed: cfg.seed,
    progressEveryMs: 500,
    onProgress: (agg) => {
      const t = now() - start;
      const dt = (t - lastT) / 1000;
      if (dt > 0) {
        const rate = (agg.updates - lastUpdates) / dt;
        if (rate > peakTps) peakTps = rate;
      }
      lastT = t;
      lastUpdates = agg.updates;
    },
  });
  const r = res.report;
  if (peakTps === 0) peakTps = r.updatesPerSec;

  // --- settlement success on an in-process sample (cluster artifacts stay in workers) ---
  const sampleTunnels = Math.min(cfg.settlementSample ?? 50, cfg.tunnels);
  let settlementSuccessRate = 1;
  if (sampleTunnels > 0) {
    const swarm = new AgentSwarm({
      agents: Math.max(2, Math.min(cfg.agents || 2, sampleTunnels * 2)),
      tunnels: sampleTunnels,
      behaviors: cfg.behaviors,
      initialBalance: cfg.initialBalance,
      seed: cfg.seed,
    });
    swarm
      .activityGenerator(signMode === "none" ? "full" : signMode)
      .runSteps(sampleTunnels * 50);
    swarm.settleAll(BigInt(Math.floor(now())));
    settlementSuccessRate = swarm.settlementSuccessRate();
  }

  return {
    cores,
    workers,
    signMode,
    behaviors: cfg.behaviors ?? ["payment"],
    tunnels: cfg.tunnels,
    activeParticipants: cfg.agents,
    elapsedMs: res.elapsedMs,
    totalInteractions: r.updates,
    avgTps: r.updatesPerSec,
    peakTps,
    perCoreTps: r.updatesPerSec / workers,
    signaturesPerSec: r.signaturesPerSec,
    verificationsPerSec: r.verificationsPerSec,
    bytesPerSec: r.bytesPerSec,
    bandwidthBytes: r.bytes,
    bytesPerUpdate: r.updates > 0 ? r.bytes / r.updates : 0,
    settlementSuccessRate,
  };
}

/** Human-readable one-screen summary. */
export function formatReport(rep: BenchReport): string {
  const n = (x: number) =>
    x.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return [
    `Sui Tunnel benchmark`,
    `  config         : ${rep.tunnels} tunnels, ${rep.activeParticipants} agents, ` +
      `${rep.workers}/${rep.cores} workers, signMode=${
        rep.signMode
      }, behaviors=${rep.behaviors.join("+")}`,
    `  elapsed        : ${(rep.elapsedMs / 1000).toFixed(2)}s`,
    `  interactions   : ${n(rep.totalInteractions)}`,
    `  effective TPS  : avg ${n(rep.avgTps)}  peak ${n(
      rep.peakTps
    )}  (per-core ${n(rep.perCoreTps)})`,
    `  signatures/sec : ${n(rep.signaturesPerSec)}`,
    `  verifies/sec   : ${n(rep.verificationsPerSec)}`,
    `  bandwidth      : ${n(rep.bytesPerSec)} B/s (${rep.bytesPerUpdate.toFixed(
      0
    )} B/update)`,
    `  settlement     : ${(rep.settlementSuccessRate * 100).toFixed(
      1
    )}% success (sample)`,
  ].join("\n");
}
