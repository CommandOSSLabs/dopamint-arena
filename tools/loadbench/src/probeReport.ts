/**
 * `--probe` report shape and its markdown twin. The JSON is the machine record
 * written to `--out`; `renderProbeMarkdown` renders the same data in the
 * `report.ts` / `ablationReport.ts` style (metadata header + tables) for humans.
 */

import type { LimitBound, PredictedCeilings } from "./probeLimits";

const PREFIX = "[localnet/probe]";

/** Run-wide context for the report header. */
export interface ProbeMeta {
  env: string;
  rpcUrl: string;
  packageId: string;
  coinType: string;
  refGasPriceMist: string;
  startedAtIso: string;
  /** Signer-pool size actually used by the throughput phase (0 if not run). */
  poolSize: number;
  stakeMist: number;
  samples: number;
}

/** One opens-per-PTB sweep step. `events`/`commands` are structural (4·N, N+1). */
export interface OpenSweepRow {
  N: number;
  ok: boolean;
  wallMs: number;
  gasPerOpenMist: number;
  events: number;
  commands: number;
  /** Present on a failing step: the raw error and its classified PTB bound. */
  error?: string;
  bound?: LimitBound;
}

export interface OpensPerPtb {
  /** Largest N that opened successfully (the knee). */
  max: number;
  /** Which PTB ceiling the first failure hit. */
  bindingLimit: LimitBound | null;
  sweep: OpenSweepRow[];
  predicted: PredictedCeilings;
}

/** One closes-per-PTB sweep step (a single PTB settling K tunnels). */
export interface CloseSweepRow {
  K: number;
  ok: boolean;
  wallMs: number;
  /** Present on a failing step: the raw error and its classified PTB bound. */
  error?: string;
  bound?: LimitBound;
}

export interface ClosesPerPtb {
  /** Largest K settled in one PTB (the knee). `reachedCap` ⇒ the sweep cap was hit
   *  without a failure, so the true knee is ≥ max. */
  max: number;
  bindingLimit: LimitBound | null;
  reachedCap: boolean;
  sweep: CloseSweepRow[];
}

export interface OpenThroughputRow {
  batch: number;
  pool: number;
  offeredRate: number;
  acceptedOpensPerSec: number;
  p50Ms: number;
  p99Ms: number;
  errorRate: number;
}

export interface CloseThroughputRow {
  pool: number;
  /** Closes staged + settled per lane (one batched PTB when ≤ CLOSE_BATCH). */
  workingSet: number;
  offeredRate: number;
  acceptedClosesPerSec: number;
  p50Ms: number;
  p99Ms: number;
  errorRate: number;
}

export interface Throughput {
  open: OpenThroughputRow[];
  close: CloseThroughputRow[];
  openCeilingPerSec: number;
  closeCeilingPerSec: number;
}

export interface GasLine {
  computation: number;
  storage: number;
  rebate: number;
  netMist: number;
  netSui: number;
}

export interface GasSection {
  openMist: GasLine;
  closeMist: GasLine;
  vsTestnet: { openDeltaSui: number; closeDeltaSui: number };
}

export interface Derived {
  netSuiPerTunnel: number;
  tunnelsSettledPerSec: number | null;
}

/** The full `--probe` record. Phase sections are null when that phase is skipped. */
export interface ProbeReport {
  meta: ProbeMeta;
  opensPerPtb: OpensPerPtb | null;
  closesPerPtb: ClosesPerPtb | null;
  throughput: Throughput | null;
  gas: GasSection | null;
  derived: Derived;
}

const n2 = (x: number) => x.toFixed(2);
const n1 = (x: number) => x.toFixed(1);

function opensSection(o: OpensPerPtb): string[] {
  const out: string[] = [];
  out.push("## Opens-per-PTB knee");
  out.push("");
  out.push(`- **Max opens / PTB:** ${o.max}`);
  out.push(`- **Binding limit:** ${o.bindingLimit ?? "—"}`);
  out.push(
    `- **Predicted:** event-budget N=${o.predicted.eventBudgetN}, ` +
      `command-budget N=${o.predicted.commandBudgetN}, ` +
      `gas-cap N=${o.predicted.gasCapN}, ` +
      `default-100M N=${o.predicted.gasAtDefault100M_N}`,
  );
  out.push("");
  out.push("| N | ok | wall ms | gas/open MIST | events | commands | bound |");
  out.push("|--:|:--:|--------:|--------------:|-------:|---------:|-------|");
  for (const r of o.sweep) {
    out.push(
      `| ${r.N} | ${r.ok ? "ok" : "FAIL"} | ${n1(r.wallMs)} | ` +
        `${Math.round(r.gasPerOpenMist)} | ${r.events} | ${r.commands} | ${r.bound ?? ""} |`,
    );
  }
  out.push("");
  return out;
}

function closesSection(c: ClosesPerPtb): string[] {
  const out: string[] = [];
  out.push("## Closes-per-PTB knee");
  out.push("");
  out.push(
    `- **Max closes / PTB:** ${c.max}${c.reachedCap ? " (sweep cap reached — knee is ≥ this)" : ""}`,
  );
  out.push(`- **Binding limit:** ${c.bindingLimit ?? "—"}`);
  out.push("");
  out.push("| K | ok | wall ms | bound |");
  out.push("|--:|:--:|--------:|-------|");
  for (const r of c.sweep) {
    out.push(`| ${r.K} | ${r.ok ? "ok" : "FAIL"} | ${n1(r.wallMs)} | ${r.bound ?? ""} |`);
  }
  out.push("");
  return out;
}

function throughputSection(t: Throughput): string[] {
  const out: string[] = [];
  out.push("## Throughput (back-pressure)");
  out.push("");
  out.push(`- **Open ceiling:** ${n1(t.openCeilingPerSec)} opens/s`);
  out.push(`- **Close ceiling:** ${n1(t.closeCeilingPerSec)} closes/s`);
  out.push("");
  out.push("### Opens");
  out.push("");
  out.push("| batch | pool | offered/s | accepted/s | p50 ms | p99 ms | err |");
  out.push("|------:|-----:|----------:|-----------:|-------:|-------:|----:|");
  for (const r of t.open) {
    out.push(
      `| ${r.batch} | ${r.pool} | ${n1(r.offeredRate)} | ` +
        `${n1(r.acceptedOpensPerSec)} | ${n1(r.p50Ms)} | ${n1(r.p99Ms)} | ${n2(r.errorRate)} |`,
    );
  }
  out.push("");
  out.push("### Closes");
  out.push("");
  out.push("| batch | pool | offered/s | accepted/s | p50 ms | p99 ms | err |");
  out.push("|------:|-----:|----------:|-----------:|-------:|-------:|----:|");
  for (const r of t.close) {
    out.push(
      `| ${r.workingSet} | ${r.pool} | ${n1(r.offeredRate)} | ${n1(r.acceptedClosesPerSec)} | ` +
        `${n1(r.p50Ms)} | ${n1(r.p99Ms)} | ${n2(r.errorRate)} |`,
    );
  }
  out.push("");
  return out;
}

function gasSection(g: GasSection): string[] {
  const row = (label: string, l: GasLine) =>
    `| ${label} | ${l.computation} | ${l.storage} | ${l.rebate} | ` +
    `${l.netMist} | ${l.netSui.toFixed(6)} |`;
  return [
    "## Per-tx gas",
    "",
    "| tx | computation | storage | rebate | net MIST | net SUI |",
    "|----|------------:|--------:|-------:|---------:|--------:|",
    row("open", g.openMist),
    row("close", g.closeMist),
    "",
    `- **vs testnet:** open ${g.vsTestnet.openDeltaSui >= 0 ? "+" : ""}` +
      `${g.vsTestnet.openDeltaSui.toFixed(6)} SUI, close ` +
      `${g.vsTestnet.closeDeltaSui >= 0 ? "+" : ""}` +
      `${g.vsTestnet.closeDeltaSui.toFixed(6)} SUI`,
    "",
  ];
}

/** Markdown twin of a {@link ProbeReport}: header bullets + per-phase tables. */
export function renderProbeMarkdown(r: ProbeReport): string {
  const m = r.meta;
  const lines: string[] = [];
  lines.push(`# loadbench probe — ${m.env}`);
  lines.push("");
  lines.push(`- **Env:** ${m.env}`);
  lines.push(`- **RPC:** ${m.rpcUrl}`);
  lines.push(`- **Package:** ${m.packageId}`);
  lines.push(`- **Coin type:** ${m.coinType}`);
  lines.push(`- **Reference gas price:** ${m.refGasPriceMist} MIST`);
  lines.push(`- **Pool size:** ${m.poolSize}`);
  lines.push(`- **Stake:** ${m.stakeMist} MIST/seat`);
  lines.push(`- **Samples:** ${m.samples}`);
  lines.push(`- **Started:** ${m.startedAtIso}`);
  lines.push("");
  if (r.opensPerPtb) lines.push(...opensSection(r.opensPerPtb));
  if (r.closesPerPtb) lines.push(...closesSection(r.closesPerPtb));
  if (r.throughput) lines.push(...throughputSection(r.throughput));
  if (r.gas) lines.push(...gasSection(r.gas));
  lines.push("## Derived");
  lines.push("");
  lines.push(`- **Net SUI / tunnel (open+close):** ${r.derived.netSuiPerTunnel.toFixed(6)}`);
  lines.push(
    `- **Tunnels settled / s:** ${
      r.derived.tunnelsSettledPerSec == null
        ? "—"
        : n1(r.derived.tunnelsSettledPerSec)
    }`,
  );
  lines.push("");
  return lines.join("\n");
}

/** One-line stdout summary, in the `[localnet/probe]` label style. */
export function renderProbeSummary(r: ProbeReport): string {
  const parts: string[] = [];
  if (r.opensPerPtb) {
    parts.push(
      `opens/PTB=${r.opensPerPtb.max} (${r.opensPerPtb.bindingLimit ?? "?"})`,
    );
  }
  if (r.closesPerPtb) {
    parts.push(
      `closes/PTB=${r.closesPerPtb.max}${r.closesPerPtb.reachedCap ? "+" : ""} ` +
        `(${r.closesPerPtb.bindingLimit ?? "?"})`,
    );
  }
  if (r.throughput) {
    parts.push(
      `open=${n1(r.throughput.openCeilingPerSec)}/s`,
      `close=${n1(r.throughput.closeCeilingPerSec)}/s`,
    );
  }
  if (r.gas) {
    parts.push(
      `gas open=${r.gas.openMist.netSui.toFixed(6)} close=${r.gas.closeMist.netSui.toFixed(6)} SUI`,
    );
  }
  return `${PREFIX} ${parts.join("  ")}`;
}

/** `probe-<env>-<stamp>.md` (or `.json`); valid filename on host + in-container. */
export function probeBasename(env: string, stamp: string, ext: string): string {
  return `probe-${env}-${stamp}.${ext}`;
}
