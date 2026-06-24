/**
 * Local multi-game TPS comparison runner — uses Bun + the bundled solo driver.
 *
 * Runs the single-thread `dist/bench/solo.js` driver in parallel across all CPU
 * cores, one game at a time, then reports the aggregate effective TPS per game.
 *
 * Usage:
 *   cd frontend
 *   bun src/bench/solo-local.ts --duration 10000
 *   bun src/bench/solo-local.ts --games blackjack,bomb-it --duration 5000
 */

import os from "node:os";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { GAME_KITS, type GameId } from "@/agent/gameKit";

interface RunResult {
  gameId: GameId;
  processes: number;
  totalTps: number;
  peakTps: number;
  elapsedMs: number;
}

const GAME_IDS = Object.keys(GAME_KITS) as GameId[];

/** Games excluded from the default comparison because they have a finite state
 *  surface (e.g. canvas fills up / cells lock) and crash the naive self-play loop. */
const DEFAULT_EXCLUDED: GameId[] = ["pixel-paint", "pixel-duel"];

const SOLO_JS = "dist/bench/solo.js";
const SOLO_TS = "src/bench/solo.ts";

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

function needsBuild(): boolean {
  if (!existsSync(SOLO_JS)) return true;
  const jsTime = statSync(SOLO_JS).mtimeMs;
  const tsTime = statSync(SOLO_TS).mtimeMs;
  return tsTime > jsTime;
}

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function ensureBuilt(): Promise<void> {
  if (!needsBuild()) return;
  console.log("Building bench bundle…");
  await runCommand("pnpm", ["build:bench"]);
}

function runOne(
  gameId: GameId,
  processIndex: number,
  durationMs: number,
): Promise<{ tps: number; peak: number }> {
  return new Promise((resolve, reject) => {
    const seed = processIndex + 1;
    const proc = spawn(
      "bun",
      [SOLO_JS, gameId, "full", String(durationMs), String(seed)],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "inherit"],
      },
    );

    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`process ${processIndex} for ${gameId} exited with ${code}`));
        return;
      }
      const tpsMatch = stdout.match(/STEPS_PER_S=(\d+)/);
      const peakMatch = stdout.match(/PEAK_TPS=(\d+)/);
      const tps = tpsMatch ? Number(tpsMatch[1]) : 0;
      const peak = peakMatch ? Number(peakMatch[1]) : 0;
      resolve({ tps, peak });
    });
  });
}

async function benchmarkGame(
  gameId: GameId,
  processes: number,
  durationMs: number,
): Promise<RunResult> {
  const t0 = Date.now();
  const settled = await Promise.allSettled(
    Array.from({ length: processes }, (_, i) => runOne(gameId, i, durationMs)),
  );
  const elapsedMs = Date.now() - t0;
  const results = settled
    .map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      console.error(`  [${gameId}] process ${i} failed: ${s.reason?.message ?? s.reason}`);
      return { tps: 0, peak: 0 };
    })
    .filter((r): r is { tps: number; peak: number } => r !== undefined);
  return {
    gameId,
    processes,
    totalTps: results.reduce((sum, r) => sum + r.tps, 0),
    peakTps: results.reduce((sum, r) => sum + r.peak, 0),
    elapsedMs,
  };
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const durationMs = Number(args.duration ?? process.env.BENCH_DURATION ?? 10000);
  const rawGames = args.games;

  let gameIds: GameId[];
  if (rawGames) {
    const requested = rawGames.split(",").map((g) => g.trim()) as GameId[];
    const invalid = requested.filter((g) => !GAME_IDS.includes(g));
    if (invalid.length > 0) {
      console.error(`Unknown game(s): ${invalid.join(", ")}`);
      console.error(`Supported: ${GAME_IDS.join(", ")}`);
      process.exit(1);
    }
    gameIds = requested;
  } else {
    gameIds = GAME_IDS.filter((g) => !DEFAULT_EXCLUDED.includes(g));
  }

  await ensureBuilt();

  const cores = os.cpus().length;
  const processes = process.env.BENCH_PROCESSES
    ? Math.max(1, Number(process.env.BENCH_PROCESSES))
    : Math.max(1, cores);

  console.log(`Local multi-game TPS benchmark (Bun)`);
  console.log(`  duration   : ${durationMs} ms`);
  console.log(`  cores      : ${cores}`);
  console.log(`  processes  : ${processes} per game`);
  console.log(`  games      : ${gameIds.join(", ")}\n`);

  const results: RunResult[] = [];
  for (const gameId of gameIds) {
    process.stdout.write(`${gameId.padEnd(14)} running ${processes} processes… `);
    const res = await benchmarkGame(gameId, processes, durationMs);
    results.push(res);
    console.log(`avg ${formatNumber(res.totalTps)} TPS`);
  }

  results.sort((a, b) => b.totalTps - a.totalTps);

  console.log("\n--- Ranking ---");
  console.log(`#  game            avg TPS      peak TPS     processes`);
  results.forEach((r, i) => {
    const rank = String(i + 1).padStart(2);
    const game = r.gameId.padEnd(15);
    const avg = formatNumber(r.totalTps).padStart(12);
    const peak = formatNumber(r.peakTps).padStart(12);
    console.log(`${rank} ${game} ${avg} ${peak} ${r.processes}`);
  });

  console.log(`\nWinner: ${results[0]!.gameId} @ ${formatNumber(results[0]!.totalTps)} TPS`);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});
