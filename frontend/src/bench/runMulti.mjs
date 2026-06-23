/**
 * Runtime-agnostic multi-worker driver for the off-chain TPS bench.
 *
 * Spawns the bundled worker (dist/bench/offchainTpsWorker.js) directly and
 * aggregates counters. Works under both `node` and `bun` — unlike offchainTps.js
 * main, whose async/lifecycle path silently no-ops under bun. Bundle the worker
 * first (esbuild), then: `bun src/bench/runMulti.mjs --workers 144 ...`.
 */
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const RT = typeof Bun !== "undefined" ? `bun-${Bun.version}` : `node-${process.version}`;
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const num = (k, d) => Number(arg(k, d));

const game = arg("game", "blackjack");
const signMode = arg("sign-mode", "full");
const backend = arg("backend", "native");
const W = num("workers", Math.max(1, os.cpus().length - 1));
const tunnels = num("tunnels", 1000);
const durationMs = num("duration", 10000);

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "bench", "offchainTpsWorker.js");
const per = Array.from({ length: W }, (_, i) => Math.floor(tunnels / W) + (i < tunnels % W ? 1 : 0));

const shard = new Array(W).fill(0);
const start = Date.now();
await Promise.all(
  Array.from({ length: W }, (_, i) => new Promise((resolve, reject) => {
    const w = new Worker(workerPath, {
      workerData: { shardIndex: i, gameId: game, tunnels: per[i], signMode, durationMs, seed: 1, reportEveryMs: 1000, backend },
    });
    w.on("message", (m) => { if (m.type === "done" || m.type === "progress") shard[i] = m.counters.updates; });
    w.on("error", reject);
    w.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`worker ${i} exit ${c}`))));
  })),
);
const elapsed = (Date.now() - start) / 1000;
const updates = shard.reduce((a, b) => a + b, 0);
console.log(`[${RT}] ${game} ${signMode} backend=${backend} workers=${W} tunnels=${tunnels} | ${updates.toLocaleString()} updates in ${elapsed.toFixed(1)}s = ${Math.round(updates / elapsed).toLocaleString()} TPS`);
