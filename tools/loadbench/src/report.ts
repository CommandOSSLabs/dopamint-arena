import { ratePerSec } from "./metrics";

export type GameStatus = "ok" | "failed";

/** One game's multi-core swarm outcome in an all-games run. Failed games carry the error and no metrics. */
export interface GameResult {
  game: string;
  status: GameStatus;
  workers: number;
  matches: number;
  moves: number;
  elapsedMs: number;
  /** System CPU utilization while this game ran: how busy the cores were (0–100%). */
  cpuUtilAvgPct: number;
  cpuUtilPeakPct: number;
  error?: string;
}

/** Run-wide context for the report header and filename. */
export interface ReportMeta {
  env: string;
  channel: string;
  anchor: string;
  workers: number;
  concurrency: number;
  /** Cores the CPU % is measured against: cgroup quota in a capped container, else host cores. */
  totalCores: number;
  cpuBasis?: "cgroup" | "system";
  /** Per-game time budget in seconds; present when the run is time-capped. */
  durationSec?: number;
  /** Per-game fixed match count; present when the run is count-capped. */
  matches?: number;
  packageId?: string;
  startedAtIso: string;
  resources: string;
}

export interface Aggregate {
  okCount: number;
  failedCount: number;
  totalMoves: number;
  totalMatches: number;
  totalElapsedMs: number;
  overallMovesPerSec: number;
  overallMatchesPerSec: number;
  /** Busiest game's sustained utilization and the highest instantaneous utilization (0–100%). */
  busiestAvgUtilPct: number;
  peakUtilPct: number;
}

/** Totals over the OK games only. Rates are summed-work / summed-wall (games run sequentially). */
export function aggregate(results: GameResult[]): Aggregate {
  const ok = results.filter((r) => r.status === "ok");
  const totalMoves = ok.reduce((a, r) => a + r.moves, 0);
  const totalMatches = ok.reduce((a, r) => a + r.matches, 0);
  const totalElapsedMs = ok.reduce((a, r) => a + r.elapsedMs, 0);
  return {
    okCount: ok.length,
    failedCount: results.length - ok.length,
    totalMoves,
    totalMatches,
    totalElapsedMs,
    overallMovesPerSec: ratePerSec(totalMoves, totalElapsedMs),
    overallMatchesPerSec: ratePerSec(totalMatches, totalElapsedMs),
    busiestAvgUtilPct: ok.length ? Math.max(...ok.map((r) => r.cpuUtilAvgPct)) : 0,
    peakUtilPct: ok.length ? Math.max(...ok.map((r) => r.cpuUtilPeakPct)) : 0,
  };
}

/** Human description of the per-game cap: time budget or fixed match count. */
function capLabel(meta: ReportMeta): string {
  if (meta.durationSec) return `${meta.durationSec}s per game`;
  if (meta.matches) return `${meta.matches} matches per game`;
  return "default per game";
}

const movesPerSec = (r: GameResult) => (r.status === "ok" ? ratePerSec(r.moves, r.elapsedMs) : 0);
const matchesPerSec = (r: GameResult) => (r.status === "ok" ? ratePerSec(r.matches, r.elapsedMs) : 0);

/** Plain-text table for stdout. TPS = move throughput; CPU % = system core utilization. */
export function renderTable(results: GameResult[], agg: Aggregate): string {
  const header = ["Game", "Status", "Workers", "Matches", "Moves", "TPS (moves/s)", "Matches/s", "CPU avg %", "CPU pk %", "Error"];
  const rows = results.map((r) => [
    r.game,
    r.status === "ok" ? "ok" : "FAILED",
    String(r.workers),
    String(r.matches),
    String(r.moves),
    movesPerSec(r).toFixed(1),
    matchesPerSec(r).toFixed(2),
    `${r.cpuUtilAvgPct.toFixed(0)}%`,
    `${r.cpuUtilPeakPct.toFixed(0)}%`,
    r.error ?? "",
  ]);
  rows.push([
    "TOTAL",
    `${agg.okCount} ok/${agg.failedCount} failed`,
    "",
    String(agg.totalMatches),
    String(agg.totalMoves),
    agg.overallMovesPerSec.toFixed(1),
    agg.overallMatchesPerSec.toFixed(2),
    `${agg.busiestAvgUtilPct.toFixed(0)}%`,
    `${agg.peakUtilPct.toFixed(0)}%`,
    "",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(header), fmt(header.map((_, i) => "-".repeat(widths[i]))), ...rows.map(fmt)].join("\n");
}

/** Markdown report: metadata header, per-game table, aggregate. */
export function renderMarkdown(meta: ReportMeta, results: GameResult[], agg: Aggregate): string {
  const rows = results.map(
    (r) =>
      `| ${r.game} | ${r.status === "ok" ? "ok" : "FAILED"} | ${r.workers} | ${r.matches} | ${r.moves} | ${movesPerSec(r).toFixed(1)} | ${matchesPerSec(r).toFixed(2)} | ${r.cpuUtilAvgPct.toFixed(0)}% | ${r.cpuUtilPeakPct.toFixed(0)}% | ${r.error ?? ""} |`,
  );
  return [
    `# loadbench report — ${meta.env} (${meta.channel}/${meta.anchor})`,
    "",
    `- **Env:** ${meta.env}`,
    `- **Channel / anchor:** ${meta.channel} / ${meta.anchor}`,
    `- **Cap:** ${capLabel(meta)} (workers ${meta.workers}, concurrency ${meta.concurrency})`,
    `- **CPU measured vs:** ${meta.totalCores} cores (${meta.cpuBasis === "cgroup" ? "container quota" : "host"})`,
    `- **Package:** ${meta.packageId ?? "—"}`,
    `- **Started:** ${meta.startedAtIso}`,
    `- **Resources:** ${meta.resources}`,
    "",
    "## Per-game results",
    "",
    "| Game | Status | Workers | Matches | Moves | TPS (moves/s) | Matches/s | CPU avg % | CPU pk % | Error |",
    "|------|--------|--------:|--------:|------:|--------------:|----------:|----------:|---------:|-------|",
    ...rows,
    "",
    "## Aggregate",
    "",
    `- **Games:** ${agg.okCount} ok, ${agg.failedCount} failed`,
    `- **Total moves / matches:** ${agg.totalMoves} / ${agg.totalMatches}`,
    `- **Overall TPS (moves/s):** ${agg.overallMovesPerSec.toFixed(1)}`,
    `- **Overall Matches/s:** ${agg.overallMatchesPerSec.toFixed(2)}`,
    `- **Busiest CPU (sustained):** ${agg.busiestAvgUtilPct.toFixed(0)}% of ${meta.totalCores} cores`,
    `- **Peak CPU (instantaneous):** ${agg.peakUtilPct.toFixed(0)}% of ${meta.totalCores} cores`,
    `- **Total bench time:** ${(agg.totalElapsedMs / 1000).toFixed(1)}s`,
    "",
  ].join("\n");
}

/** `bench-<env>-<channel>-<anchor>-<YYYYMMDD-HHMMSS>.md`, valid in-container and on host. */
export function reportBasename(meta: ReportMeta): string {
  const stamp = meta.startedAtIso.replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "");
  return `bench-${meta.env}-${meta.channel}-${meta.anchor}-${stamp}.md`;
}
