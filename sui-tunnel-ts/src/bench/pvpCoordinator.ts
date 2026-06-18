/**
 * Multi-instance coordination for the PvP load test.
 *
 * - `broadcastStart` / `waitForStart` use a small S3 object as a global start
 *   signal so all generator instances begin at roughly the same time.
 * - `aggregateReports` downloads per-instance JSON reports, aligns the per-second
 *   buckets, and produces a combined summary.
 *
 * CLI usage:
 *   pnpm tsx src/bench/pvpCoordinator.ts broadcast --bucket <name> [--start-at <ms>]
 *   pnpm tsx src/bench/pvpCoordinator.ts aggregate --bucket <name>
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { PvpMetrics } from "./pvpMetrics";

export interface PvpReport {
  instanceId: string;
  startedAt: number;
  durationMs: number;
  metrics: PvpMetrics;
}

export interface AggregatedReport {
  instances: number;
  totalActions: number;
  matchesCompleted: number;
  errors: number;
  durationSeconds: number;
  peakActionsPerSecond: number;
  sustainedActionsPerSecond: number;
  combinedLatencyMs: number[];
  perSecondBuckets: number[];
}

const START_KEY = "pvp-start-signal.json";
const REPORT_PREFIX = "reports/";

export function createS3Client(region?: string): S3Client {
  return new S3Client({ region: region ?? process.env.AWS_REGION ?? "us-east-1" });
}

export async function broadcastStart(
  s3: S3Client,
  bucket: string,
  startAt: number
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: START_KEY,
      Body: JSON.stringify({ startAt }),
      ContentType: "application/json",
    })
  );
}

export async function waitForStart(
  s3: S3Client,
  bucket: string,
  pollMs = 500
): Promise<number> {
  while (true) {
    try {
      const obj = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: START_KEY,
        })
      );
      const body = await obj.Body?.transformToString();
      if (!body) {
        throw new Error("empty start signal body");
      }
      const parsed = JSON.parse(body) as { startAt: number };
      return parsed.startAt;
    } catch (err) {
      if (
        err instanceof Error &&
        !err.name.includes("NoSuchKey") &&
        !err.message.includes("NoSuchKey")
      ) {
        console.error("waitForStart error:", err);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

export async function uploadReport(
  s3: S3Client,
  bucket: string,
  report: PvpReport
): Promise<void> {
  const key = `${REPORT_PREFIX}${report.instanceId}-${report.startedAt}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(report),
      ContentType: "application/json",
    })
  );
}

export async function listReports(
  s3: S3Client,
  bucket: string
): Promise<PvpReport[]> {
  const list = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: REPORT_PREFIX,
    })
  );
  const keys =
    list.Contents?.map((o) => o.Key).filter((k): k is string => !!k) ?? [];
  const reports: PvpReport[] = [];
  for (const key of keys) {
    try {
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      const body = await obj.Body?.transformToString();
      if (body) {
        reports.push(JSON.parse(body) as PvpReport);
      }
    } catch (err) {
      console.error(`failed to download report ${key}:`, err);
    }
  }
  return reports;
}

/**
 * Sum per-second bucket arrays after padding shorter runs with zeros.
 * Buckets are assumed to start at the same wall-clock second because all
 * generators wait for the same start signal.
 */
export function sumBuckets(buckets: number[][]): number[] {
  const maxLen = buckets.reduce((m, b) => Math.max(m, b.length), 0);
  const out = new Array<number>(maxLen).fill(0);
  for (const b of buckets) {
    for (let i = 0; i < b.length; i++) {
      out[i] += b[i];
    }
  }
  return out;
}

export function aggregateReports(reports: PvpReport[]): AggregatedReport {
  const totalActions = reports.reduce(
    (sum, r) => sum + r.metrics.actionsTotal,
    0
  );
  const matchesCompleted = reports.reduce(
    (sum, r) => sum + r.metrics.matchesCompleted,
    0
  );
  const errors = reports.reduce((sum, r) => sum + r.metrics.errors, 0);
  const durationSeconds =
    reports.length > 0
      ? Math.max(...reports.map((r) => r.durationMs)) / 1000
      : 0;

  const buckets = sumBuckets(reports.map((r) => r.metrics.actionsPerSecond));
  const peakActionsPerSecond =
    buckets.length > 0 ? Math.max(...buckets) : 0;
  const sustainedActionsPerSecond =
    durationSeconds > 0 ? totalActions / durationSeconds : 0;

  const combinedLatencyMs = reports.flatMap(
    (r) => r.metrics.latencyHistogramMs
  );

  return {
    instances: reports.length,
    totalActions,
    matchesCompleted,
    errors,
    durationSeconds,
    peakActionsPerSecond,
    sustainedActionsPerSecond,
    combinedLatencyMs,
    perSecondBuckets: buckets,
  };
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const cmd = args[0];
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else if (key.includes("=")) {
      const [k, ...rest] = key.split("=");
      flags[k] = rest.join("=");
    } else {
      flags[key] = "true";
    }
  }
  return { cmd, flags };
}

async function main(argv: string[]): Promise<void> {
  const { cmd, flags } = parseArgs(argv);
  const bucket = flags.bucket ?? process.env.REPORTS_BUCKET;
  if (!bucket) {
    throw new Error("--bucket or REPORTS_BUCKET is required");
  }
  const s3 = createS3Client(flags.region);

  if (cmd === "broadcast") {
    const startAt = flags["start-at"]
      ? Number(flags["start-at"])
      : Date.now() + 10_000;
    await broadcastStart(s3, bucket, startAt);
    console.log(`broadcast startAt=${startAt} to s3://${bucket}/${START_KEY}`);
    return;
  }

  if (cmd === "aggregate") {
    const reports = await listReports(s3, bucket);
    const summary = aggregateReports(reports);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  throw new Error(`unknown command: ${cmd}`);
}

if (require.main === module) {
  main(process.argv).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
