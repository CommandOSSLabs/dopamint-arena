/**
 * Off-chain TPS benchmark using the canonical game-bot kits.
 *
 * Drives real frontend protocols (the same ones human hooks use) in self-play
 * tunnels, dual-signs every transition, and verifies signatures in "full" mode.
 * No on-chain transactions — this measures pure off-chain throughput.
 *
 * Examples:
 *   node --import tsx src/bench/offchainTps.ts --game tictactoe --tunnels 1000 --updates-per-tunnel 100
 *   node --import tsx src/bench/offchainTps.ts --game blackjack --tunnels 100 --duration 5000
 *   node --import tsx src/bench/offchainTps.ts --game tictactoe --tunnels 10000 --updates-per-tunnel 100 --workers 8
 */

import os from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { GAME_KITS, type GameId } from "@/agent/gameKit";
import {
  addInto,
  mergeCounters,
  newCounters,
  rateReport,
  type Counters,
  type RateReport,
} from "sui-tunnel-ts/telemetry/metrics";
import type { SignMode } from "sui-tunnel-ts/core/tunnel";
import type { WorkerMessage } from "./offchainTpsWorker";

interface BenchConfig {
  gameId: GameId;
  tunnels: number;
  workers: number;
  durationMs?: number;
  updatesPerTunnel?: number;
  signMode: SignMode;
  seed: number;
  reportEveryMs: number;
}

interface BenchReport {
  gameId: GameId;
  signMode: SignMode;
  tunnels: number;
  workers: number;
  cores: number;
  elapsedMs: number;
  totalInteractions: number;
  avgTps: number;
  peakTps: number;
  perCoreTps: number;
  signaturesPerSec: number;
  verificationsPerSec: number;
  bytesPerSec: number;
  bytesPerUpdate: number;
  tunnelsOpened: number;
  tunnelsClosed: number;
  errors: number;
}

const GAME_IDS = Object.keys(GAME_KITS) as GameId[];

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function distribute(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const rem = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rem ? 1 : 0));
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function formatReport(rep: BenchReport): string {
  return [
    "Off-chain kit TPS benchmark",
    `  game           : ${rep.gameId}`,
    `  config         : ${rep.tunnels} concurrent tunnels, ${rep.workers}/${rep.cores} workers, signMode=${rep.signMode}`,
    `  elapsed        : ${(rep.elapsedMs / 1000).toFixed(2)}s`,
    `  interactions   : ${formatNumber(rep.totalInteractions)}`,
    `  effective TPS  : avg ${formatNumber(rep.avgTps)}  peak ${formatNumber(rep.peakTps)}  (per-core ${formatNumber(rep.perCoreTps)})`,
    `  signatures/sec : ${formatNumber(rep.signaturesPerSec)}`,
    `  verifies/sec   : ${formatNumber(rep.verificationsPerSec)}`,
    `  bandwidth      : ${formatNumber(rep.bytesPerSec)} B/s (${rep.bytesPerUpdate.toFixed(0)} B/update)`,
    `  tunnels opened : ${formatNumber(rep.tunnelsOpened)}`,
    `  tunnels closed : ${formatNumber(rep.tunnelsClosed)}`,
    rep.errors > 0 ? `  errors         : ${formatNumber(rep.errors)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runBenchmark(cfg: BenchConfig): Promise<BenchReport> {
  const W = cfg.workers;
  const tunnelsPer = distribute(cfg.tunnels, W);
  const maxSteps = cfg.updatesPerTunnel ? cfg.tunnels * cfg.updatesPerTunnel : undefined;
  const stepsPer = maxSteps !== undefined ? distribute(maxSteps, W) : undefined;

  const perShard: Counters[] = Array.from({ length: W }, () => newCounters());
  const start = Date.now();
  let peakTps = 0;
  let lastUpdates = 0;
  let lastT = 0;

  const isTs = import.meta.url.endsWith(".ts");
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), `offchainTpsWorker${isTs ? ".ts" : ".js"}`);
  const execArgv = isTs ? ["--import", "tsx"] : [];

  const progressTimer = setInterval(() => {
    const agg = mergeCounters(perShard);
    const t = Date.now() - start;
    const dt = (t - lastT) / 1000;
    if (dt > 0) {
      const rate = (agg.updates - lastUpdates) / dt;
      if (rate > peakTps) peakTps = rate;
    }
    lastT = t;
    lastUpdates = agg.updates;
  }, cfg.reportEveryMs);

  const workers: Worker[] = [];
  const done = new Array<Promise<void>>(W);

  for (let i = 0; i < W; i++) {
    const w = new Worker(workerPath, {
      execArgv,
      workerData: {
        shardIndex: i,
        gameId: cfg.gameId,
        tunnels: tunnelsPer[i],
        signMode: cfg.signMode,
        durationMs: cfg.durationMs,
        maxSteps: stepsPer?.[i],
        seed: cfg.seed,
        reportEveryMs: cfg.reportEveryMs,
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
    clearInterval(progressTimer);
    await Promise.all(workers.map((w) => w.terminate()));
  }

  const elapsedMs = Date.now() - start;
  const agg = mergeCounters(perShard);
  const report = rateReport(agg, elapsedMs);
  if (peakTps === 0) peakTps = report.updatesPerSec;

  return {
    gameId: cfg.gameId,
    signMode: cfg.signMode,
    tunnels: cfg.tunnels,
    workers: W,
    cores: os.cpus().length,
    elapsedMs,
    totalInteractions: agg.updates,
    avgTps: report.updatesPerSec,
    peakTps,
    perCoreTps: report.updatesPerSec / W,
    signaturesPerSec: report.signaturesPerSec,
    verificationsPerSec: report.verificationsPerSec,
    bytesPerSec: report.bytesPerSec,
    bytesPerUpdate: agg.updates > 0 ? agg.bytes / agg.updates : 0,
    tunnelsOpened: agg.tunnelsOpened,
    tunnelsClosed: agg.tunnelsClosed,
    errors: agg.errors,
  };
}

function main(argv: string[]): void {
  const args = parseArgs(argv);

  const gameId = (args.game as GameId) ?? "tictactoe";
  if (!GAME_IDS.includes(gameId)) {
    console.error(`Unknown game: ${gameId}. Supported: ${GAME_IDS.join(", ")}`);
    process.exit(1);
  }

  const signModeArg = args["sign-mode"];
  if (
    signModeArg !== undefined &&
    signModeArg !== "full" &&
    signModeArg !== "sign-only" &&
    signModeArg !== "none"
  ) {
    console.error(`--sign-mode must be one of full|sign-only|none, got "${signModeArg}"`);
    process.exit(1);
  }

  const num = (k: string, d: number): number => {
    if (args[k] === undefined) return d;
    const v = Number(args[k]);
    if (!Number.isFinite(v)) throw new Error(`--${k} must be a number, got "${args[k]}"`);
    return v;
  };

  const cfg: BenchConfig = {
    gameId,
    tunnels: num("tunnels", 1000),
    workers: num("workers", Math.max(1, os.cpus().length - 1)),
    durationMs: args.duration ? Number(args.duration) : undefined,
    updatesPerTunnel: args["updates-per-tunnel"] ? Number(args["updates-per-tunnel"]) : undefined,
    signMode: (signModeArg as SignMode) ?? "full",
    seed: num("seed", 1),
    reportEveryMs: num("report-every", 500),
  };

  if (cfg.durationMs === undefined && cfg.updatesPerTunnel === undefined) {
    cfg.updatesPerTunnel = 100;
  }

  runBenchmark(cfg)
    .then((rep) => {
      console.log(formatReport(rep));
      if (args.json) {
        const json = JSON.stringify(rep, null, 2);
        if (args.json !== "true") {
          writeFileSync(args.json, json, "utf8");
          console.log(`\nwrote JSON: ${args.json}`);
        } else {
          console.log("\n" + json);
        }
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
