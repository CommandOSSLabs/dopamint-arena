/**
 * CLI entry point for the PvP tic-tac-toe load generator.
 *
 * Usage:
 *   node --import tsx src/bench/pvpCli.ts --pairs 4 --duration 10000 --backendUrl ws://localhost:8080/v1/mp
 *   node --import tsx src/bench/pvpCli.ts --pairs=4 --duration=10000 --backendUrl=ws://localhost:8080/v1/mp
 *
 * Coordinated multi-instance run:
 *   node --import tsx src/bench/pvpCli.ts --pairs 10 --duration 60000 \
 *     --waitForStart --bucket <reports-bucket> --instanceId <id>
 */
import { webcrypto } from "node:crypto";

// Node 18 ships a global `crypto` without `getRandomValues`, which breaks
// @noble/curves key generation. Polyfill with the webcrypto module when needed.
if (
  typeof globalThis.crypto === "undefined" ||
  typeof globalThis.crypto.getRandomValues !== "function"
) {
  // @ts-expect-error globalThis.crypto is typed narrowly in older Node types.
  globalThis.crypto = webcrypto;
}

import { runLoadTest, LoadTestConfig } from "./pvpTicTacToeLoadTest";
import {
  createS3Client,
  waitForStart,
  uploadReport,
} from "./pvpCoordinator";

export interface PvpCliConfig extends LoadTestConfig {
  waitForStart?: boolean;
  bucket?: string;
  instanceId?: string;
  region?: string;
}

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
    waitForStart: out.waitForStart === "true" || out.waitForStart === "1",
    bucket: out.bucket ?? process.env.REPORTS_BUCKET,
    instanceId: out.instanceId ?? process.env.INSTANCE_ID,
    region: out.region ?? process.env.AWS_REGION,
  };
}

function defaultInstanceId(): string {
  return (
    process.env.INSTANCE_ID ??
    `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

export async function main(argv: string[]): Promise<void> {
  const cfg = parseArgs(argv);
  const backendCfg: LoadTestConfig = {
    backendUrl: cfg.backendUrl,
    pairs: cfg.pairs,
    durationMs: cfg.durationMs,
  };

  if (cfg.waitForStart && cfg.bucket) {
    const s3 = createS3Client(cfg.region);
    const startAt = await waitForStart(s3, cfg.bucket);
    const now = Date.now();
    const delay = startAt - now;
    if (delay > 0) {
      console.log(`waiting ${delay}ms for coordinated start`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const startedAt = Date.now();
  const metrics = await runLoadTest(backendCfg);
  console.log("Final metrics:", JSON.stringify(metrics, null, 2));

  if (cfg.bucket) {
    const s3 = createS3Client(cfg.region);
    const instanceId = cfg.instanceId ?? defaultInstanceId();
    await uploadReport(s3, cfg.bucket, {
      instanceId,
      startedAt,
      durationMs: cfg.durationMs,
      metrics,
    });
    console.log(`uploaded report for ${instanceId}`);
  }
}

if (require.main === module) {
  main(process.argv).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
