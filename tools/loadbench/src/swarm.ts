import os from "node:os";
import { Worker } from "node:worker_threads";
import { mkdirSync, writeFileSync } from "node:fs";
import { PLAYABLE } from "./games";
import { readEnvLocal } from "./env";
import { envName } from "./benchEnv";
import { ensureRelay } from "./relayProcess";
import { ratePerSec } from "./metrics";
import { startResourceMonitor, formatResources, startCpuUtilMonitor, cpuBudget } from "./resourceMonitor";
import { aggregate, renderTable, renderMarkdown, reportBasename, type GameResult } from "./report";

/** Default per-game time budget for `--all` when neither --duration nor --matches is given. */
const DEFAULT_ALL_GAME_DURATION_S = 10;

export function parseSwarmArgs(argv: string[]): {
  channel: "local" | "relay";
  anchor: "onchain" | "offchain";
  workers: number | "auto";
  concurrency: number | "auto";
  matches: number | null;
  durationS: number | null;
  memBudgetMb: number | null;
  perMatchKb: number | null;
  games: string[];
  all: boolean;
} {
  const out = {
    channel: "relay" as "local" | "relay",
    anchor: "onchain" as "onchain" | "offchain",
    workers: "auto" as number | "auto",
    concurrency: "auto" as number | "auto",
    matches: null as number | null,
    durationS: null as number | null,
    memBudgetMb: null as number | null,
    perMatchKb: null as number | null,
    games: [...PLAYABLE] as string[],
    all: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--channel") out.channel = argv[++i] as "local" | "relay";
    else if (a === "--offchain") out.anchor = "offchain";
    else if (a === "--onchain") out.anchor = "onchain";
    else if (a === "--tunnel-anchor") out.anchor = argv[++i] as "onchain" | "offchain";
    else if (a === "--workers") { i++; out.workers = argv[i] === "auto" ? "auto" : Number(argv[i]); }
    else if (a === "--concurrency") { i++; out.concurrency = argv[i] === "auto" ? "auto" : Number(argv[i]); }
    else if (a === "--matches") out.matches = Number(argv[++i]);
    else if (a === "--duration") out.durationS = Number(argv[++i]);
    else if (a === "--mem-budget-mb") out.memBudgetMb = Number(argv[++i]);
    else if (a === "--per-match-kb") out.perMatchKb = Number(argv[++i]);
    else if (a === "--games") out.games = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--all") out.all = true;
  }
  return out;
}

const DEFAULT_PER_MATCH_KB = 512;
// Low concurrency for CPU-bound (offchain/local) runs: more in-flight coroutines
// on a saturated core only thrash without increasing throughput.
const CPU_AUTO_CONCURRENCY = 2;

export function resolveFleet(
  args: { workers: number | "auto"; concurrency: number | "auto"; memBudgetMb: number | null; perMatchKb: number | null },
  sys: { cores: number; totalMem: number },
  mode: "cpu" | "io",
): { workers: number; concurrency: number } {
  const workers = args.workers === "auto" ? Math.max(1, Math.round(sys.cores * 1.5)) : args.workers;
  let concurrency: number;
  if (args.concurrency === "auto") {
    if (mode === "cpu") {
      concurrency = CPU_AUTO_CONCURRENCY;
    } else {
      const budgetBytes = args.memBudgetMb !== null ? args.memBudgetMb * 1_048_576 : sys.totalMem * 0.7;
      const perMatchBytes = (args.perMatchKb ?? DEFAULT_PER_MATCH_KB) * 1024;
      const maxInFlight = Math.max(workers, Math.floor(budgetBytes / perMatchBytes));
      concurrency = Math.max(1, Math.floor(maxInFlight / workers));
    }
  } else {
    concurrency = args.concurrency;
  }
  return { workers, concurrency };
}

/** Split `total` matches across `workers`; sums to total, length = workers. */
export function sliceMatches(total: number, workers: number): number[] {
  const base = Math.ceil(total / workers);
  const out: number[] = [];
  let rem = total;
  for (let i = 0; i < workers; i++) {
    const n = Math.min(base, Math.max(0, rem));
    out.push(n);
    rem -= n;
  }
  return out;
}

/** Run `run()` up to `concurrency` at a time until the matches cap OR duration
 *  is reached (whichever fires first, if both are set).
 *
 *  `now` is injectable so callers can drive time in unit tests without real timers. */
export async function runSwarm(
  run: () => Promise<{ moves: number }>,
  opts: {
    concurrency: number;
    matches: number | null;
    durationMs: number | null;
    now: () => number;
  },
): Promise<{ moves: number; matches: number; elapsedMs: number }> {
  const start = opts.now();
  let totalMoves = 0;
  let totalMatches = 0;
  // claimed tracks how many match slots have been reserved — checked before
  // each run to cap at opts.matches without over-shooting (JS event loop is
  // single-threaded so the check+increment pair is effectively atomic).
  let claimed = 0;

  const shouldStop = () => {
    if (opts.matches !== null && claimed >= opts.matches) return true;
    if (opts.durationMs !== null && opts.now() - start >= opts.durationMs) return true;
    return false;
  };

  async function worker() {
    while (!shouldStop()) {
      claimed++;
      const r = await run();
      totalMoves += r.moves;
      totalMatches++;
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  return { moves: totalMoves, matches: totalMatches, elapsedMs: opts.now() - start };
}

function runWorker(input: Record<string, unknown>): Promise<{ ok: boolean; moves?: number; matches?: number; error?: string }> {
  return new Promise((resolve) => {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { workerData: input });
    let settled = false;
    const settle = (v: { ok: boolean; moves?: number; matches?: number; error?: string }) => {
      if (!settled) { settled = true; resolve(v); }
    };
    w.once("message", (m) => settle(m));
    w.once("error", (e) => settle({ ok: false, error: String(e?.stack ?? e) }));
    // Safety net: a normal worker posts a message before exiting, so this only
    // fires on abnormal termination (OOM kill, uncaught crash) that skips the message.
    w.once("exit", (code) => settle({ ok: false, error: `worker exited without result (code ${code})` }));
  });
}

/** Onchain runs need the published package + a funded settler; offchain needs nothing. */
function buildOnchainEnv(args: ReturnType<typeof parseSwarmArgs>): Record<string, string> {
  const env: Record<string, string> = {};
  if (args.anchor !== "onchain") return env;
  const e = readEnvLocal();
  const pkg = process.env.TUNNEL_PACKAGE_ID ?? e.TUNNEL_PACKAGE_ID;
  if (!pkg) throw new Error("onchain run needs a package id: pass --package-id or run `bun run stack`");
  env.PACKAGE_ID = pkg;
  env.SUI_NETWORK = process.env.SUI_NETWORK ?? e.SUI_NETWORK ?? "";
  env.SUI_RPC_URL = process.env.SUI_RPC_URL ?? e.SUI_RPC_URL ?? "";
  env.SUI_SETTLER_KEY = process.env.SUI_SETTLER_KEY ?? e.SUI_SETTLER_KEY;
  if (!env.SUI_SETTLER_KEY) throw new Error("onchain run needs a settler key: pass --settler-key or run `bun run stack`");
  return env;
}

interface WorkerResult { ok: boolean; moves?: number; matches?: number; error?: string }

interface PoolWorker {
  ready: Promise<void>;
  run(cmd: { game: string; matches: number | null; durationMs: number | null }): Promise<WorkerResult>;
  done(): void;
}

/** Spawn a warm worker: it imports the engine + builds its match context once,
 *  signals ready, then runs one game per `run()` call. The (heavy) import/setup
 *  cost is paid once, before any measurement — so per-game CPU/throughput reflect
 *  only the game's run window, not fleet spin-up. */
function spawnPoolWorker(init: {
  workerId: number;
  channel: "local" | "relay";
  anchor: "onchain" | "offchain";
  concurrency: number;
  env: Record<string, string>;
}): PoolWorker {
  const w = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { ...init, pool: true } });
  let pending: ((v: WorkerResult) => void) | null = null;
  let resolveReady!: () => void;
  const ready = new Promise<void>((res) => { resolveReady = res; });
  const fail = (error: string) => { const p = pending; pending = null; p?.({ ok: false, error }); };
  w.on("message", (m: WorkerResult & { ready?: boolean }) => {
    if (m?.ready) { resolveReady(); return; }
    const p = pending; pending = null; p?.(m);
  });
  w.on("error", (e) => fail(String(e?.stack ?? e)));
  w.on("exit", (code) => { if (pending) fail(`worker exited without result (code ${code})`); });
  return {
    ready,
    run(cmd) {
      return new Promise<WorkerResult>((res) => { pending = res; w.postMessage({ type: "run", ...cmd }); });
    },
    // Terminate the thread so the process can exit; the worker is idle here (all runs done).
    done() { void w.terminate(); },
  };
}

/** Run every game through the fleet sequentially, then print a table and write a markdown report. */
async function runAllGamesReport(
  args: ReturnType<typeof parseSwarmArgs>,
  fleet: { workers: number; concurrency: number },
  env: Record<string, string>,
  durationMs: number | null,
): Promise<void> {
  const startedAtIso = new Date().toISOString();
  const tag = `${args.channel}/${args.anchor}`;

  // Spawn the fleet once; wait until every worker has imported the engine and
  // built its context. This warm-up is deliberately outside all measurement.
  const pool = Array.from({ length: fleet.workers }, (_, i) =>
    spawnPoolWorker({ workerId: i, channel: args.channel, anchor: args.anchor, concurrency: fleet.concurrency, env }),
  );
  await Promise.all(pool.map((p) => p.ready));

  const overall = startResourceMonitor();
  const results: GameResult[] = [];
  try {
    for (const game of args.games) {
      const slices = args.matches !== null ? sliceMatches(args.matches, fleet.workers) : null;
      // Workers are warm: the CPU monitor + timer now bracket only the run itself.
      const cpu = startCpuUtilMonitor();
      const start = performance.now();
      const wr = await Promise.all(
        pool.map((p, i) => p.run({ game, matches: slices ? slices[i] : null, durationMs })),
      );
      const elapsedMs = performance.now() - start;
      const cpuSummary = cpu.stop();
      const ok = wr.filter((r) => r.ok);
      const failed = wr.filter((r) => !r.ok);
      const r: GameResult = {
        game,
        status: ok.length > 0 ? "ok" : "failed",
        workers: pool.length,
        matches: ok.reduce((a, x) => a + (x.matches ?? 0), 0),
        moves: ok.reduce((a, x) => a + (x.moves ?? 0), 0),
        elapsedMs,
        cpuUtilAvgPct: cpuSummary.utilAvgPct,
        cpuUtilPeakPct: cpuSummary.utilPeakPct,
        error: failed.length ? failed.map((x) => x.error).join("; ") : undefined,
      };
      console.log(
        `[${tag}] ${game}: ${r.moves} moves over ${r.matches} matches, ${ratePerSec(r.moves, r.elapsedMs).toFixed(1)} moves/s, cpu util avg=${r.cpuUtilAvgPct.toFixed(0)}%${r.error ? ` (worker error: ${r.error})` : ""}`,
      );
      results.push(r);
    }
  } finally {
    pool.forEach((p) => p.done());
  }
  const resources = formatResources(overall.stop());

  const budget = cpuBudget();
  const meta = {
    env: envName(),
    channel: args.channel,
    anchor: args.anchor,
    workers: fleet.workers,
    concurrency: fleet.concurrency,
    totalCores: budget.cores,
    cpuBasis: budget.basis,
    durationSec: args.matches === null && durationMs !== null ? durationMs / 1000 : undefined,
    matches: args.matches ?? undefined,
    packageId: args.anchor === "onchain" ? env.PACKAGE_ID : undefined,
    startedAtIso,
    resources,
  };
  const agg = aggregate(results);
  console.log("\n" + renderTable(results, agg));
  // `../reports` resolves to tools/loadbench/reports on the host and to the
  // bind-mounted dir inside the container; the printed path is relative so it
  // is meaningful in both contexts.
  const dir = new URL("../reports", import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  const base = reportBasename(meta);
  writeFileSync(`${dir}/${base}`, renderMarkdown(meta, results, agg));
  console.log(`report: reports/${base}`);
  if (results.some((r) => r.status === "failed")) process.exitCode = 1;
}

async function main() {
  const args = parseSwarmArgs(process.argv.slice(2));
  if (args.matches === null && args.durationS === null) args.durationS = args.all ? DEFAULT_ALL_GAME_DURATION_S : 15;

  const sys = { cores: os.availableParallelism?.() ?? os.cpus().length, totalMem: os.totalmem() };
  const mode = args.anchor === "offchain" && args.channel === "local" ? "cpu" : "io";
  const { workers, concurrency } = resolveFleet(args, sys, mode);

  const env = buildOnchainEnv(args);
  const relay = args.channel === "relay" ? await ensureRelay({ wsUrl: process.env.MP_WS_URL }) : null;
  const durationMs = args.durationS !== null ? args.durationS * 1000 : null;
  const tag = `${args.channel}/${args.anchor}`;

  try {
    if (args.all) {
      await runAllGamesReport(args, { workers, concurrency }, env, durationMs);
      return;
    }

    const slices = args.matches !== null ? sliceMatches(args.matches, workers) : null;
    const monitor = startResourceMonitor();
    const start = performance.now();
    const inputs = Array.from({ length: workers }, (_, i) => ({
      workerId: i,
      channel: args.channel,
      anchor: args.anchor,
      games: args.games,
      concurrency,
      matches: slices ? slices[i] : null,
      durationMs,
      env,
    })).filter((inp) => inp.matches === null || inp.matches > 0);

    const results = await Promise.all(inputs.map(runWorker));
    const elapsedMs = performance.now() - start;
    const ok = results.filter((r) => r.ok);
    const failed = results.length - ok.length;
    const moves = ok.reduce((a, r) => a + (r.moves ?? 0), 0);
    const matches = ok.reduce((a, r) => a + (r.matches ?? 0), 0);
    const res = monitor.stop();

    console.log(`[${tag}] fleet: workers=${workers} concurrency=${concurrency}${args.workers === "auto" || args.concurrency === "auto" ? " (auto)" : ""}${failed ? ` (${failed} worker(s) failed)` : ""}`);
    console.log(`[${tag}] swarm: ${moves} moves over ${matches} matches in ${(elapsedMs / 1000).toFixed(1)}s`);
    console.log(`[${tag}] aggregate move-TPS: ${ratePerSec(moves, elapsedMs).toFixed(1)}`);
    if (args.anchor === "onchain") {
      console.log(`[${tag}] tunnels settled/s: ${ratePerSec(matches, elapsedMs).toFixed(2)} (on-chain-finality-bound)`);
    }
    console.log(`[${tag}] resources: ${formatResources(res)}`);
    for (const r of results.filter((x) => !x.ok)) console.error(`[${tag}] worker error: ${r.error}`);
  } finally {
    relay?.stop();
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
