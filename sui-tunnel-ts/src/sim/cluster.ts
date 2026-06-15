/**
 * Multi-core simulation cluster (Deliverables 1 & 5): the path to 1M+ effective TPS.
 *
 * Shards M tunnels across W worker threads (default cores-1), each running the
 * synchronous sign/verify loop on its own core, and aggregates their Counters into a
 * single rate report. Because tunnels are independent, throughput scales near-linearly
 * with cores; the whole cluster is one node process (one machine). Multiple machines'
 * reports are summed at the next layer (the benchmark harness, Deliverable 10).
 *
 * Works both under tsx (dev: worker is a .ts file, spawned with `--import tsx`) and
 * from the built output (dist: worker is .js).
 */

import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  addInto,
  Counters,
  mergeCounters,
  newCounters,
  rateReport,
  RateReport,
} from "../telemetry/metrics";
import { TunnelKind } from "./engine";
import { deriveSeed } from "./rng";
import type { WorkerMessage } from "./worker";

export interface ClusterConfig {
  /** Worker threads to spawn. Default max(1, cpus-1). */
  workers?: number;
  /** Total tunnels across all workers. */
  tunnels: number;
  users: number;
  agents: number;
  kinds?: TunnelKind[];
  /** When set, workers run mixed-behavior AgentSwarms instead of payments. */
  behaviors?: import("../agents/behaviors").BehaviorName[];
  initialBalance?: bigint;
  assignment?: "random" | "deterministic";
  signMode?: "full" | "sign-only" | "none";
  /** Run each worker for this long. */
  durationMs?: number;
  /** Or cap total updates (split across workers). */
  maxSteps?: number;
  batchSize?: number;
  seed?: number;
  /** Aggregate progress callback. */
  onProgress?: (agg: RateReport, perShard: Counters[]) => void;
  progressEveryMs?: number;
}

export interface ClusterResult {
  report: RateReport;
  perShard: Counters[];
  elapsedMs: number;
  workers: number;
}

/** Split `total` into `parts` near-equal non-negative integers summing to `total`. */
export function distribute(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const rem = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rem ? 1 : 0));
}

export async function runCluster(cfg: ClusterConfig): Promise<ClusterResult> {
  const W = Math.max(1, cfg.workers ?? os.cpus().length - 1);
  const tunnelsPer = distribute(cfg.tunnels, W);
  const usersPer = distribute(cfg.users, W);
  const agentsPer = distribute(cfg.agents, W);
  const stepsPer =
    cfg.maxSteps !== undefined ? distribute(cfg.maxSteps, W) : undefined;

  const isTs = __filename.endsWith(".ts");
  const workerPath = path.join(__dirname, `worker${isTs ? ".ts" : ".js"}`);
  const execArgv = isTs ? ["--import", "tsx"] : [];

  const perShard: Counters[] = Array.from({ length: W }, () => newCounters());
  const start = Date.now();

  let progressTimer: ReturnType<typeof setInterval> | undefined;
  if (cfg.onProgress) {
    progressTimer = setInterval(() => {
      cfg.onProgress!(
        rateReport(mergeCounters(perShard), Date.now() - start),
        perShard,
      );
    }, cfg.progressEveryMs ?? 500);
  }

  const workers: Worker[] = [];
  const done = new Array<Promise<void>>(W);

  for (let i = 0; i < W; i++) {
    const w = new Worker(workerPath, {
      execArgv,
      workerData: {
        shardIndex: i,
        tunnels: tunnelsPer[i],
        users: usersPer[i],
        agents: agentsPer[i],
        kinds: cfg.kinds,
        behaviors: cfg.behaviors,
        initialBalance: cfg.initialBalance,
        assignment: cfg.assignment,
        signMode: cfg.signMode,
        durationMs: cfg.durationMs,
        maxSteps: stepsPer?.[i],
        batchSize: cfg.batchSize,
        seed: deriveSeed(cfg.seed ?? 1, i),
        reportEveryMs: cfg.progressEveryMs ?? 500,
      },
    });
    workers.push(w);

    done[i] = new Promise<void>((resolve, reject) => {
      w.on("message", (msg: WorkerMessage) => {
        if (msg.type === "progress" || msg.type === "done") {
          perShard[msg.shard] = msg.counters;
        } else if (msg.type === "error") {
          reject(new Error(`shard ${msg.shard}: ${msg.error}`));
        }
      });
      w.on("error", reject);
      w.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`worker ${i} exited with code ${code}`));
      });
    });
  }

  try {
    await Promise.all(done);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    await Promise.all(workers.map((w) => w.terminate()));
  }

  const elapsedMs = Date.now() - start;
  const agg = newCounters();
  for (const c of perShard) addInto(agg, c);
  return {
    report: rateReport(agg, elapsedMs),
    perShard,
    elapsedMs,
    workers: W,
  };
}
