/**
 * Reproducible benchmark CLI (Deliverable 10). Examples:
 *
 *   node --import tsx src/bench/cli.ts --agents 100 --tunnels 1000 --updates-per-tunnel 1000
 *   node --import tsx src/bench/cli.ts --tunnels 10000 --updates-per-tunnel 100 --agents 1000
 *   node --import tsx src/bench/cli.ts --tunnels 2000 --duration 5000 --behaviors payment,poker,chat
 *   node dist/bench/cli.js --tunnels 1000 --updates-per-tunnel 1000 --json out.json
 *
 * Flags: --agents N --tunnels N --workers N --duration MS --updates-per-tunnel N
 *        --sign-mode full|sign-only|none --behaviors a,b,c --seed N --batch N
 *        --settlement-sample N --json [file] --csv [file]
 */

import { parseBehaviors } from "../agents/behaviors";
import { BenchReport, formatReport, runBenchmark } from "./harness";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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

function reportCsv(rep: BenchReport): string {
  const cols: (keyof BenchReport)[] = [
    "tunnels",
    "activeParticipants",
    "workers",
    "signMode",
    "elapsedMs",
    "totalInteractions",
    "avgTps",
    "peakTps",
    "perCoreTps",
    "signaturesPerSec",
    "verificationsPerSec",
    "bytesPerSec",
    "bytesPerUpdate",
    "settlementSuccessRate",
  ];
  return [
    cols.join(","),
    cols
      .map((c) => {
        const v = rep[c];
        return typeof v === "number"
          ? Number.isInteger(v)
            ? v
            : v.toFixed(3)
          : v;
      })
      .join(","),
  ].join("\n");
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const num = (k: string, d?: number) => {
    if (args[k] === undefined) return d;
    const v = Number(args[k]);
    if (!Number.isFinite(v)) {
      throw new Error(`--${k} must be a finite number, got "${args[k]}"`);
    }
    return v;
  };

  const signModeArg = args["sign-mode"];
  if (
    signModeArg !== undefined &&
    signModeArg !== "full" &&
    signModeArg !== "sign-only" &&
    signModeArg !== "none"
  ) {
    throw new Error(
      `--sign-mode must be one of full|sign-only|none, got "${signModeArg}"`
    );
  }

  const rep = await runBenchmark({
    agents: num("agents", 100)!,
    tunnels: num("tunnels", 1000)!,
    workers: num("workers"),
    durationMs: num("duration"),
    updatesPerTunnel: num("updates-per-tunnel"),
    maxSteps: num("max-steps"),
    signMode: (args["sign-mode"] as "full" | "sign-only" | "none") ?? "full",
    behaviors: args["behaviors"]
      ? parseBehaviors(args["behaviors"])
      : undefined,
    seed: num("seed"),
    batchSize: num("batch"),
    settlementSample: num("settlement-sample"),
  });

  console.log(formatReport(rep));

  if (args["json"] !== undefined) {
    const json = JSON.stringify(rep, null, 2);
    if (args["json"] !== "true") {
      const fs = await import("node:fs/promises");
      await fs.writeFile(args["json"], json, "utf8");
      console.log(`\nwrote JSON: ${args["json"]}`);
    } else {
      console.log("\n" + json);
    }
  }
  if (args["csv"] !== undefined) {
    const csv = reportCsv(rep);
    if (args["csv"] !== "true") {
      const fs = await import("node:fs/promises");
      await fs.writeFile(args["csv"], csv, "utf8");
      console.log(`wrote CSV: ${args["csv"]}`);
    } else {
      console.log("\n" + csv);
    }
  }
}

// Run when invoked directly (tsx or compiled).
if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
