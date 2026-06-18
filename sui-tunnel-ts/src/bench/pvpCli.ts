/**
 * CLI entry point for the PvP tic-tac-toe load generator.
 *
 * Usage:
 *   node --import tsx src/bench/pvpCli.ts --pairs 4 --duration 10000 --backendUrl ws://localhost:8080/v1/mp
 *   node --import tsx src/bench/pvpCli.ts --pairs=4 --duration=10000 --backendUrl=ws://localhost:8080/v1/mp
 */
import { runLoadTest } from "./pvpTicTacToeLoadTest";

export function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else if (key.includes("=")) {
      const [k, ...rest] = key.split("=");
      out[k] = rest.join("=");
    } else {
      out[key] = "true";
    }
  }

  const pairs = Number(out.pairs ?? "1");
  const durationMs = Number(out.duration ?? "10000");
  if (!Number.isFinite(pairs) || !Number.isInteger(pairs) || pairs < 0) {
    throw new Error(`Invalid --pairs: ${out.pairs}`);
  }
  if (
    !Number.isFinite(durationMs) ||
    !Number.isInteger(durationMs) ||
    durationMs <= 0
  ) {
    throw new Error(`Invalid --duration: ${out.duration}`);
  }

  return {
    pairs,
    durationMs,
    backendUrl:
      out.backendUrl ?? process.env.BACKEND_URL ?? "ws://localhost:8080/v1/mp",
  };
}

export async function main(argv: string[]): Promise<void> {
  const cfg = parseArgs(argv);
  const metrics = await runLoadTest(cfg);
  console.log("Final metrics:", JSON.stringify(metrics, null, 2));
}

if (require.main === module) {
  main(process.argv).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
