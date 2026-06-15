/**
 * Worker-thread entry for the simulation cluster.
 *
 * Each worker owns a shard of tunnels and runs the synchronous sign/verify loop on
 * its own CPU core, periodically posting Counters snapshots to the main thread. This
 * is how the framework scales past one core toward 1M+ effective TPS: aggregate rate
 * ≈ per-core rate × cores. Spawned by sim/cluster.ts; not meant to be imported.
 */

import { parentPort, workerData } from "node:worker_threads";
import { Simulator, TunnelKind } from "./engine";
import { AgentSwarm } from "../agents/Agent";
import { BehaviorName } from "../agents/behaviors";
import { Counters } from "../telemetry/metrics";
import { ActivityGenerator } from "./activityGen";

export interface WorkerShardConfig {
  shardIndex: number;
  tunnels: number;
  users: number;
  agents: number;
  kinds?: TunnelKind[];
  /** When set, the shard runs an AgentSwarm with these behaviors instead of payments. */
  behaviors?: BehaviorName[];
  initialBalance?: bigint;
  assignment?: "random" | "deterministic";
  signMode?: "full" | "sign-only" | "none";
  durationMs?: number;
  maxSteps?: number;
  batchSize?: number;
  seed?: number;
  reportEveryMs?: number;
}

export type WorkerMessage =
  | { type: "progress"; shard: number; counters: Counters }
  | { type: "done"; shard: number; counters: Counters }
  | { type: "error"; shard: number; error: string };

async function main(): Promise<void> {
  const cfg = workerData as WorkerShardConfig;
  const port = parentPort;
  if (!port) throw new Error("worker.ts must run as a worker thread");

  try {
    // Behavior-aware: run a mixed-protocol AgentSwarm when behaviors are given,
    // otherwise the default payments Simulator (max-throughput headline workload).
    let gen: ActivityGenerator<unknown, unknown>;
    let counters: Counters;
    if (cfg.behaviors && cfg.behaviors.length) {
      const swarm = new AgentSwarm({
        agents: Math.max(2, cfg.users + cfg.agents),
        tunnels: cfg.tunnels,
        behaviors: cfg.behaviors,
        initialBalance: cfg.initialBalance,
        seed: cfg.seed,
      });
      gen = swarm.activityGenerator(cfg.signMode ?? "full");
      counters = swarm.counters;
    } else {
      const sim = new Simulator({
        users: cfg.users,
        agents: cfg.agents,
        tunnels: cfg.tunnels,
        kinds: cfg.kinds,
        initialBalance: cfg.initialBalance,
        assignment: cfg.assignment,
        seed: cfg.seed,
      });
      gen = sim.activityGenerator(cfg.signMode ?? "full") as ActivityGenerator<
        unknown,
        unknown
      >;
      counters = sim.counters;
    }

    // counters is the live object the generator mutates; snapshot-copy it.
    const snapshot = (): Counters => ({ ...counters });
    const timer = setInterval(() => {
      port.postMessage({
        type: "progress",
        shard: cfg.shardIndex,
        counters: snapshot(),
      } as WorkerMessage);
    }, cfg.reportEveryMs ?? 250);

    await gen.run({
      durationMs: cfg.durationMs,
      maxSteps: cfg.maxSteps,
      batchSize: cfg.batchSize,
    });

    clearInterval(timer);
    port.postMessage({
      type: "done",
      shard: cfg.shardIndex,
      counters: snapshot(),
    } as WorkerMessage);
  } catch (e) {
    port.postMessage({
      type: "error",
      shard: cfg.shardIndex,
      error: e instanceof Error ? e.message : String(e),
    } as WorkerMessage);
  }
}

void main();
