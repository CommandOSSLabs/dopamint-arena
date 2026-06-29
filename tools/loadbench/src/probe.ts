/**
 * `--probe` entry: a real-transaction measurement probe against a Sui localnet.
 * It does NOT play games — it opens and cooperatively settles real tunnels to
 * measure three things the swarm benchmark can't isolate:
 *
 *   A) open-knee   — the max tunnels openable in ONE PTB, and which ceiling binds.
 *   B) throughput  — sustained opens/s and closes/s under a signer-pool, with
 *                    back-pressure (closed-loop by default; open-loop pacer with
 *                    --target-rate).
 *   C) gas         — per-tx net SUI for one open and one close vs the testnet ref.
 *
 * Only the owned-coin signer-pool path is measured: `execute` signs with owned
 * gas coins, so SIP-58 address-balance gas is out of reach here by construction.
 *
 * Resolution order for infra: flag → `.env.local` → process env. `PACKAGE_ID` is
 * pushed into the process env BEFORE any tx is built so the reused `buildTarget`
 * (which falls back to `process.env.PACKAGE_ID` at call time) resolves the target.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SuiClient, getFullnodeUrl } from "./suiClient";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { SignerPool } from "../../../sui-tunnel-ts/src/onchain/gas";
import { buildCloseWithRootFromSettlement } from "../../../sui-tunnel-ts/src/onchain/txbuilders";
import { execute } from "../../../sui-tunnel-ts/src/onchain/lifecycle";
import type { TunnelOpenSpec } from "../../../sui-tunnel-ts/src/onchain/createAndFund";
import { SUI_COIN_TYPE } from "../../../sui-tunnel-ts/src/config";
import { readEnvLocal } from "./env";
import { envName } from "./benchEnv";
import { makeSeats, type Seats } from "./match";
import { openSpec } from "./onchain";
import { openBatch } from "./probeOpen";
import { withTxRetry } from "./probeRetry";
import {
  buildOpeningSettlement,
  closeBatchWithRoot,
  type CloseTarget,
} from "./probeClose";
import {
  gasBudgetFor,
  classify,
  netGas,
  predictedCeilings,
  EVENTS_PER_OPEN,
  MAX_TX_GAS_BUDGET_MIST,
  MIST_PER_SUI,
  OPEN_TESTNET_SUI,
  CLOSE_TESTNET_SUI,
  type GasUsedRaw,
  type NetGas,
} from "./probeLimits";
import { ratePerSec, percentile } from "./metrics";
import {
  renderProbeMarkdown,
  renderProbeSummary,
  probeBasename,
  type ProbeReport,
  type ProbeMeta,
  type OpensPerPtb,
  type OpenSweepRow,
  type ClosesPerPtb,
  type CloseSweepRow,
  type Throughput,
  type OpenThroughputRow,
  type CloseThroughputRow,
  type GasSection,
  type GasLine,
  type Derived,
} from "./probeReport";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Per-(batch,pool) wall window for the throughput phase. No flag exposes this:
 *  the sweep over pool sizes IS the ramp; each cell is measured over this window. */
const THROUGHPUT_WINDOW_MS = 4000;
/** Tunnels each signer opens to form the close-throughput working set. */
const CLOSE_WORKING_SET = 32;

// ── args ──────────────────────────────────────────────────────────────────────

export type ProbePhase = "open-knee" | "close-knee" | "throughput" | "gas" | "all";

export interface ProbeArgs {
  phase: ProbePhase;
  batchSizes: number[];
  poolSizes: number[];
  /** Tunnels each signer stages + settles per close-throughput lane (one batched PTB
   *  when ≤ CLOSE_BATCH). Raising it toward the close knee lifts the close ceiling. */
  closeWorkingSet: number;
  /** Open-loop offered opens/s ceiling; null ⇒ closed-loop. */
  targetRate: number | null;
  rateSteps: number | null;
  gasBudgetMist: number | null;
  coinType: string;
  stakeMist: bigint;
  rpcUrl: string | null;
  packageId: string | null;
  /** ENV-VAR NAME holding the settler key — never the key value (key-safety). */
  settlerKeyEnv: string;
  keysFile: string | null;
  out: string | null;
  samples: number;
}

function need(argv: string[], i: number, flag: string): string {
  if (i >= argv.length) throw new Error(`${flag} requires a value`);
  return argv[i];
}

function posNum(s: string, flag: string): number {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`${flag} must be a positive number (got ${s})`);
  return n;
}

function posInt(s: string, flag: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${flag} must be a positive integer (got ${s})`);
  return n;
}

function parseNumList(s: string, flag: string): number[] {
  const xs = s.split(",").map((x) => Number(x.trim()));
  if (xs.length === 0 || xs.some((n) => !Number.isFinite(n) || n <= 0))
    throw new Error(`${flag} must be a comma-separated list of positive numbers (got ${s})`);
  return xs;
}

export function parseProbeArgs(argv: string[]): ProbeArgs {
  const a: ProbeArgs = {
    phase: "all",
    batchSizes: [1, 8, 32, 64, 128, 256, 320],
    poolSizes: [1, 4, 8],
    closeWorkingSet: CLOSE_WORKING_SET,
    targetRate: null,
    rateSteps: null,
    gasBudgetMist: null,
    coinType: SUI_COIN_TYPE,
    stakeMist: 1000n,
    rpcUrl: null,
    packageId: null,
    settlerKeyEnv: "SUI_SETTLER_KEY",
    keysFile: null,
    out: null,
    samples: 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case "--probe":
        break; // mode marker; consumed by the cli dispatch
      case "--phase": {
        const v = need(argv, ++i, f);
        if (
          v !== "open-knee" &&
          v !== "close-knee" &&
          v !== "throughput" &&
          v !== "gas" &&
          v !== "all"
        )
          throw new Error(
            `--phase must be open-knee|close-knee|throughput|gas|all (got ${v})`,
          );
        a.phase = v;
        break;
      }
      case "--batch-sizes":
        a.batchSizes = parseNumList(need(argv, ++i, f), f);
        break;
      case "--pool-sizes":
        a.poolSizes = parseNumList(need(argv, ++i, f), f);
        break;
      case "--close-working-set":
        a.closeWorkingSet = posInt(need(argv, ++i, f), f);
        break;
      case "--target-rate":
        a.targetRate = posNum(need(argv, ++i, f), f);
        break;
      case "--rate-steps":
        a.rateSteps = posInt(need(argv, ++i, f), f);
        break;
      case "--gas-budget-mist":
        a.gasBudgetMist = posInt(need(argv, ++i, f), f);
        break;
      case "--coin-type":
        a.coinType = need(argv, ++i, f);
        break;
      case "--stake-mist":
        a.stakeMist = BigInt(posInt(need(argv, ++i, f), f));
        break;
      case "--rpc-url":
        a.rpcUrl = need(argv, ++i, f);
        break;
      case "--package-id":
        a.packageId = need(argv, ++i, f);
        break;
      case "--settler-key-env":
        a.settlerKeyEnv = need(argv, ++i, f);
        break;
      case "--keys-file":
        a.keysFile = need(argv, ++i, f);
        break;
      case "--out":
        a.out = need(argv, ++i, f);
        break;
      case "--samples":
        a.samples = posInt(need(argv, ++i, f), f);
        break;
      default:
        throw new Error(`unknown probe flag: ${f}`);
    }
  }
  if (a.batchSizes.length === 0) throw new Error("--batch-sizes is empty");
  if (a.poolSizes.length === 0) throw new Error("--pool-sizes is empty");
  // --target-rate enables the open-loop pacer; default a small ramp if unset.
  if (a.targetRate != null && a.rateSteps == null) a.rateSteps = 4;
  if (a.rateSteps != null && a.targetRate == null)
    throw new Error("--rate-steps requires --target-rate");
  return a;
}

// ── infra resolution ────────────────────────────────────────────────────────

function resolveRpcUrl(args: ProbeArgs, envLocal: Record<string, string>): string {
  return (
    args.rpcUrl ??
    envLocal.SUI_RPC_URL ??
    process.env.SUI_RPC_URL ??
    getFullnodeUrl("localnet")
  );
}

function resolvePackageId(args: ProbeArgs, envLocal: Record<string, string>): string {
  const pkg =
    args.packageId ??
    envLocal.TUNNEL_PACKAGE_ID ??
    envLocal.PACKAGE_ID ??
    process.env.TUNNEL_PACKAGE_ID ??
    process.env.PACKAGE_ID;
  if (!pkg)
    throw new Error(
      "package id not resolved: pass --package-id, or run 'bun run stack' to write .env.local (TUNNEL_PACKAGE_ID).",
    );
  return pkg;
}

/** Resolve the settler keypair from the env-var NAME only; the value is never
 *  taken from argv and never logged (key-safety policy). */
function resolveSettler(args: ProbeArgs, envLocal: Record<string, string>): Ed25519Keypair {
  const name = args.settlerKeyEnv;
  const val = process.env[name] ?? envLocal[name];
  if (!val)
    throw new Error(
      `settler key not found: set $${name}, or add ${name} to .env.local via 'bun run stack'. ` +
        `The probe reads the key by env-var NAME and never accepts it on argv.`,
    );
  const { secretKey } = decodeSuiPrivateKey(val);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

/** Load the funded signer pool from keys.json (`[{secretKey,address}]`). */
function loadPool(args: ProbeArgs): Ed25519Keypair[] {
  const path = args.keysFile
    ? resolve(process.cwd(), args.keysFile)
    : new URL("../keys.json", import.meta.url).pathname;
  if (!existsSync(path))
    throw new Error(
      `keys file not found: ${path} (run 'bun run stack' to fund a pool, or pass --keys-file).`,
    );
  const raw = JSON.parse(readFileSync(path, "utf8")) as Array<{ secretKey: string }>;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error(`keys file ${path} has no keys`);
  return raw.map((k) =>
    Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(k.secretKey).secretKey),
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** N fresh seats (ephemeral keys) + their open specs, each staking `stakeMist`/seat. */
function makeBatch(n: number, stakeMist: bigint): { specs: TunnelOpenSpec[]; seats: Seats[] } {
  const specs: TunnelOpenSpec[] = [];
  const seats: Seats[] = [];
  for (let i = 0; i < n; i++) {
    const s = makeSeats(randomUUID(), { a: stakeMist, b: stakeMist }, 0n);
    seats.push(s);
    specs.push(openSpec(s));
  }
  return { specs, seats };
}

/** On-chain `created_at` (ms). All tunnels opened in one PTB share it (one clock
 *  read per tx), so the caller reads it once per batch and reuses it. */
async function readCreatedAt(client: SuiClient, tunnelId: string): Promise<bigint> {
  const obj = await client.getObject({ id: tunnelId, options: { showContent: true } });
  const fields = (obj.data?.content as { fields?: { created_at?: string | number } } | undefined)
    ?.fields;
  return BigInt(fields?.created_at ?? 0);
}

/** A tunnel's `created_at` and `party_a` address. A batch open returns created ids in
 *  objectChanges order (Sui sorts created objects by id), NOT spec order — so a caller
 *  closing a batch must match each tunnel back to its seat by party_a address; settling
 *  with the wrong seat's keys aborts `close_cooperative_with_root` (signature check). */
async function readTunnelParty(
  client: SuiClient,
  tunnelId: string,
): Promise<{ createdAt: bigint; partyAAddr: string }> {
  const obj = await client.getObject({ id: tunnelId, options: { showContent: true } });
  const fields = (
    obj.data?.content as
      | {
          fields?: {
            created_at?: string | number;
            party_a?: { fields?: { address?: string } };
          };
        }
      | undefined
  )?.fields;
  const partyAAddr = fields?.party_a?.fields?.address;
  if (!partyAAddr)
    throw new Error(`tunnel ${tunnelId} content has no party_a.address`);
  return { createdAt: BigInt(fields?.created_at ?? 0), partyAAddr };
}

function budgetForOpen(args: ProbeArgs, n: number): number {
  return args.gasBudgetMist ?? gasBudgetFor(n);
}

/** Largest open batch used to stage close targets — under the ~255 open-PTB knee. */
const OPEN_CHUNK_FOR_CLOSE = 200;

/** Open `n` fresh tunnels off `signer` (chunked under the open knee) and pair each to
 *  its seat by on-chain party_a address, returning close targets with opening
 *  settlements. The created-id order from a batch open is NOT the spec order (see
 *  readTunnelParty), so the party-address match is what gives each settlement the
 *  correct party keys. */
async function openCloseTargets(
  client: SuiClient,
  signer: Ed25519Keypair,
  n: number,
  args: ProbeArgs,
): Promise<CloseTarget[]> {
  const targets: CloseTarget[] = [];
  for (let off = 0; off < n; off += OPEN_CHUNK_FOR_CLOSE) {
    const cnt = Math.min(OPEN_CHUNK_FOR_CLOSE, n - off);
    const { specs, seats } = makeBatch(cnt, args.stakeMist);
    const res = await openBatch(client, signer, specs, {
      gasBudgetMist: budgetForOpen(args, cnt),
      coinType: args.coinType,
    });
    const seatByPartyA = new Map(seats.map((s) => [s.partyA.address, s]));
    for (const id of res.ids) {
      const { createdAt, partyAAddr } = await readTunnelParty(client, id);
      const seat = seatByPartyA.get(partyAAddr);
      if (!seat)
        throw new Error(`openCloseTargets: no seat matches tunnel ${id} party_a ${partyAAddr}`);
      targets.push({ tunnelId: id, settlement: buildOpeningSettlement(seat, id, createdAt) });
    }
  }
  return targets;
}

// ── phase A: opens-per-PTB knee ────────────────────────────────────────────────

/** Try to open N tunnels in one PTB; bump the auto budget once on a gas-budget
 *  failure (a small budget is not a structural knee). Returns the sweep row. */
async function attemptOpen(
  client: SuiClient,
  signer: Ed25519Keypair,
  N: number,
  args: ProbeArgs,
): Promise<OpenSweepRow> {
  const { specs } = makeBatch(N, args.stakeMist);
  let budget = budgetForOpen(args, N);
  let lastErr = "";
  for (let tries = 0; tries < 2; tries++) {
    try {
      const res = await openBatch(client, signer, specs, {
        gasBudgetMist: budget,
        coinType: args.coinType,
      });
      const net = netGas(res.gasUsed);
      return {
        N,
        ok: true,
        wallMs: res.wallMs,
        gasPerOpenMist: net.netMist / N,
        events: EVENTS_PER_OPEN * N,
        commands: N + 1,
      };
    } catch (e) {
      lastErr = String((e as Error)?.message ?? e);
      const bound = classify(lastErr);
      if (
        bound === "gas-budget" &&
        tries === 0 &&
        args.gasBudgetMist == null &&
        budget < MAX_TX_GAS_BUDGET_MIST
      ) {
        budget = Math.min(MAX_TX_GAS_BUDGET_MIST, budget * 2);
        continue;
      }
      break;
    }
  }
  return {
    N,
    ok: false,
    wallMs: 0,
    gasPerOpenMist: 0,
    events: EVENTS_PER_OPEN * N,
    commands: N + 1,
    error: lastErr,
    bound: classify(lastErr),
  };
}

async function runOpenKnee(
  client: SuiClient,
  signer: Ed25519Keypair,
  args: ProbeArgs,
): Promise<OpensPerPtb> {
  const sizes = [...new Set(args.batchSizes)].sort((x, y) => x - y);
  const sweep: OpenSweepRow[] = [];
  let lastOk = 0;
  let firstFail = "";
  let firstFailN = -1;
  for (const N of sizes) {
    const row = await attemptOpen(client, signer, N, args);
    sweep.push(row);
    if (row.ok) {
      lastOk = N;
    } else {
      firstFail = row.error ?? "";
      firstFailN = N;
      break;
    }
  }
  // Bisect between last-ok and first-fail to pin the exact knee.
  if (firstFailN > lastOk + 1) {
    let lo = lastOk;
    let hi = firstFailN;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const row = await attemptOpen(client, signer, mid, args);
      sweep.push(row);
      if (row.ok) lo = mid;
      else {
        hi = mid;
        if (!firstFail) firstFail = row.error ?? "";
      }
    }
    lastOk = lo;
  }
  sweep.sort((x, y) => x.N - y.N || Number(x.ok) - Number(y.ok));
  return {
    max: lastOk,
    bindingLimit: firstFail ? classify(firstFail) : null,
    sweep,
    predicted: predictedCeilings(),
  };
}

// ── phase A2: closes-per-PTB knee ───────────────────────────────────────────────

/** Stage K fresh tunnels, then attempt to settle ALL K in ONE PTB. A structural PTB
 *  failure (event / command / tx-size / gas budget) is the close knee. `withTxRetry`
 *  only clears transient stale-gas conflicts, so structural ceilings still surface. */
async function attemptCloseKnee(
  client: SuiClient,
  signer: Ed25519Keypair,
  K: number,
  args: ProbeArgs,
): Promise<CloseSweepRow> {
  let targets: CloseTarget[];
  try {
    targets = await openCloseTargets(client, signer, K, args);
  } catch (e) {
    // Could not even stage K tunnels — a setup failure, not a close-PTB ceiling.
    return {
      K,
      ok: false,
      wallMs: 0,
      error: `setup: ${String((e as Error)?.message ?? e)}`,
      bound: "unknown",
    };
  }
  const start = performance.now();
  try {
    await withTxRetry(async () => {
      const tx = new Transaction();
      for (const t of targets)
        buildCloseWithRootFromSettlement(tx, t.tunnelId, t.settlement, args.coinType);
      tx.setGasBudget(args.gasBudgetMist ?? gasBudgetFor(K));
      return execute(client, signer, tx, { waitForFinality: true });
    });
    return { K, ok: true, wallMs: performance.now() - start };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return { K, ok: false, wallMs: 0, error: msg, bound: classify(msg) };
  }
}

/** Max closes settleable in one PTB: double K until a structural failure, then bisect.
 *  Each step stages K FRESH tunnels (a successful close consumes them, so K can't be
 *  reused), so cost grows with the knee — capped at CAP. */
async function runCloseKnee(
  client: SuiClient,
  signer: Ed25519Keypair,
  args: ProbeArgs,
): Promise<ClosesPerPtb> {
  const CAP = 1024;
  const sweep: CloseSweepRow[] = [];
  let lastOk = 0;
  let firstFailK = -1;
  for (let K = 32; K <= CAP; K *= 2) {
    const row = await attemptCloseKnee(client, signer, K, args);
    sweep.push(row);
    if (row.ok) lastOk = K;
    else {
      firstFailK = K;
      break;
    }
  }
  // Bisect the gap between the last success and the first failure.
  if (firstFailK > lastOk + 1) {
    let lo = lastOk;
    let hi = firstFailK;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const row = await attemptCloseKnee(client, signer, mid, args);
      sweep.push(row);
      if (row.ok) lo = mid;
      else hi = mid;
    }
    lastOk = lo;
  }
  sweep.sort((a, b) => a.K - b.K || Number(a.ok) - Number(b.ok));
  // Binding limit = the SMALLEST failing K (the knee-adjacent failure, e.g. max+1) —
  // not the doubling overshoot, which can hit a different (larger) ceiling.
  const kneeFail = sweep.find((r) => !r.ok && r.K > lastOk);
  return {
    max: lastOk,
    bindingLimit: kneeFail ? (kneeFail.bound ?? classify(kneeFail.error ?? "")) : null,
    reachedCap: firstFailK === -1, // never failed within CAP ⇒ true knee ≥ max
    sweep,
  };
}

// ── phase B: throughput ─────────────────────────────────────────────────────

/** Closed-loop open cell: each signer continuously opens `batch` from its own gas
 *  coin for one window (in-flight = pool size). Accepted/s is the steady rate. */
async function openCellClosedLoop(
  client: SuiClient,
  signers: Ed25519Keypair[],
  batch: number,
  args: ProbeArgs,
): Promise<OpenThroughputRow> {
  const perBatchMs: number[] = [];
  let attempts = 0;
  let okBatches = 0;
  const deadline = performance.now() + THROUGHPUT_WINDOW_MS;
  const t0 = performance.now();
  const runner = async (signer: Ed25519Keypair) => {
    while (performance.now() < deadline) {
      const { specs } = makeBatch(batch, args.stakeMist);
      attempts++;
      const start = performance.now();
      try {
        await openBatch(client, signer, specs, {
          gasBudgetMist: budgetForOpen(args, batch),
          coinType: args.coinType,
        });
        perBatchMs.push(performance.now() - start);
        okBatches++;
      } catch {
        // counted as a failed attempt (error-rate signal)
      }
    }
  };
  await Promise.all(signers.map(runner));
  const wallMs = performance.now() - t0;
  return {
    batch,
    pool: signers.length,
    offeredRate: ratePerSec(attempts * batch, wallMs),
    acceptedOpensPerSec: ratePerSec(okBatches * batch, wallMs),
    p50Ms: percentile(perBatchMs, 50),
    p99Ms: percentile(perBatchMs, 99),
    errorRate: attempts > 0 ? (attempts - okBatches) / attempts : 0,
  };
}

/** One open-loop step: fire batches at a fixed cadence (regardless of completion)
 *  across the pool for one window, then drain. Surfaces back-pressure as a gap
 *  between offered and accepted (and as single-coin equivocation if a signer is
 *  re-fired while its prior tx is still in flight). */
async function paceOpenWindow(
  client: SuiClient,
  signers: Ed25519Keypair[],
  batch: number,
  offeredOpensPerSec: number,
  args: ProbeArgs,
): Promise<OpenThroughputRow> {
  const batchesPerSec = offeredOpensPerSec / batch;
  const intervalMs = batchesPerSec > 0 ? 1000 / batchesPerSec : THROUGHPUT_WINDOW_MS;
  const perBatchMs: number[] = [];
  const inflight: Promise<void>[] = [];
  let attempts = 0;
  let okBatches = 0;
  let cursor = 0;
  const deadline = performance.now() + THROUGHPUT_WINDOW_MS;
  const t0 = performance.now();
  while (performance.now() < deadline) {
    const signer = signers[cursor % signers.length];
    cursor++;
    const { specs } = makeBatch(batch, args.stakeMist);
    attempts++;
    const start = performance.now();
    inflight.push(
      openBatch(client, signer, specs, {
        gasBudgetMist: budgetForOpen(args, batch),
        coinType: args.coinType,
      })
        .then(() => {
          perBatchMs.push(performance.now() - start);
          okBatches++;
        })
        .catch(() => {}),
    );
    await sleep(intervalMs);
  }
  await Promise.allSettled(inflight);
  const wallMs = performance.now() - t0;
  return {
    batch,
    pool: signers.length,
    offeredRate: offeredOpensPerSec,
    acceptedOpensPerSec: ratePerSec(okBatches * batch, wallMs),
    p50Ms: percentile(perBatchMs, 50),
    p99Ms: percentile(perBatchMs, 99),
    errorRate: attempts > 0 ? (attempts - okBatches) / attempts : 0,
  };
}

/** Ramp the offered rate through `rate-steps` toward `target-rate`; stop when
 *  accepted plateaus (<0.9·offered), p99 knees (>2× the first step), or errors
 *  climb (>10%). Returns one row per executed step. */
async function openCellOpenLoop(
  client: SuiClient,
  signers: Ed25519Keypair[],
  batch: number,
  args: ProbeArgs,
): Promise<OpenThroughputRow[]> {
  const steps = args.rateSteps ?? 1;
  const target = args.targetRate ?? 0;
  const rows: OpenThroughputRow[] = [];
  let firstP99 = 0;
  for (let step = 1; step <= steps; step++) {
    const offered = (target * step) / steps;
    const row = await paceOpenWindow(client, signers, batch, offered, args);
    rows.push(row);
    if (step === 1) firstP99 = row.p99Ms;
    const plateau = row.acceptedOpensPerSec < 0.9 * row.offeredRate;
    const p99Knee = firstP99 > 0 && row.p99Ms > 2 * firstP99;
    const errClimb = row.errorRate > 0.1;
    if (plateau || p99Knee || errClimb) break;
  }
  return rows;
}

/** Close-throughput cell (keyed by pool only): build a working set of opened
 *  tunnels (each signer funds its own), then settle them round-robin. */
async function closeCell(
  client: SuiClient,
  signers: Ed25519Keypair[],
  args: ProbeArgs,
): Promise<CloseThroughputRow> {
  const targets: CloseTarget[] = [];
  for (const signer of signers) {
    targets.push(...(await openCloseTargets(client, signer, args.closeWorkingSet, args)));
  }
  const subPool = new SignerPool(signers);
  const t0 = performance.now();
  const r = await closeBatchWithRoot(client, subPool, targets, {
    // Let closeBatchWithRoot size the gas budget per batched chunk; only an explicit
    // --gas-budget-mist overrides it (a fixed gasBudgetFor(1) would starve a batch).
    gasBudgetMist: args.gasBudgetMist ?? undefined,
    coinType: args.coinType,
  });
  const wallMs = performance.now() - t0;
  return {
    pool: signers.length,
    workingSet: args.closeWorkingSet,
    offeredRate: ratePerSec(r.attempted, wallMs),
    acceptedClosesPerSec: ratePerSec(r.attempted - r.errors, wallMs),
    p50Ms: percentile(r.latenciesMs, 50),
    p99Ms: percentile(r.latenciesMs, 99),
    errorRate: r.attempted > 0 ? r.errors / r.attempted : 0,
  };
}

async function runThroughput(
  client: SuiClient,
  pool: Ed25519Keypair[],
  args: ProbeArgs,
): Promise<{ throughput: Throughput; poolSizeUsed: number }> {
  const requestedMax = Math.max(...args.poolSizes);
  if (pool.length < requestedMax) {
    process.stdout.write(
      `[localnet/probe] pool clamped to ${pool.length} keys (requested up to ${requestedMax})\n`,
    );
  }
  const poolSizes = [...new Set(args.poolSizes.map((p) => Math.min(p, pool.length)))].sort(
    (x, y) => x - y,
  );
  const open: OpenThroughputRow[] = [];
  for (const batch of args.batchSizes) {
    for (const p of poolSizes) {
      const signers = pool.slice(0, p);
      if (args.targetRate != null) {
        open.push(...(await openCellOpenLoop(client, signers, batch, args)));
      } else {
        open.push(await openCellClosedLoop(client, signers, batch, args));
      }
    }
  }
  const close: CloseThroughputRow[] = [];
  for (const p of poolSizes) {
    close.push(await closeCell(client, pool.slice(0, p), args));
  }
  return {
    throughput: {
      open,
      close,
      openCeilingPerSec: open.length ? Math.max(...open.map((r) => r.acceptedOpensPerSec)) : 0,
      closeCeilingPerSec: close.length
        ? Math.max(...close.map((r) => r.acceptedClosesPerSec))
        : 0,
    },
    poolSizeUsed: poolSizes.length ? Math.max(...poolSizes) : 0,
  };
}

// ── phase C: per-tx gas ─────────────────────────────────────────────────────

/** Close one tunnel and return its net gas (Phase C needs the close's gasUsed,
 *  which the throughput close path does not surface). */
async function closeOneCaptureGas(
  client: SuiClient,
  signer: Ed25519Keypair,
  target: CloseTarget,
  args: ProbeArgs,
): Promise<NetGas> {
  const res = await withTxRetry(async () => {
    const tx = new Transaction();
    buildCloseWithRootFromSettlement(tx, target.tunnelId, target.settlement, args.coinType);
    tx.setGasBudget(args.gasBudgetMist ?? gasBudgetFor(1));
    return execute(client, signer, tx, { waitForFinality: true });
  });
  return netGas((res.effects as { gasUsed: GasUsedRaw }).gasUsed);
}

/** Median of each gas field across samples (robust to a cold-cache outlier). */
function medianLine(samples: NetGas[]): GasLine {
  const med = (sel: (n: NetGas) => number) => percentile(samples.map(sel), 50);
  const computation = med((s) => s.computation);
  const storage = med((s) => s.storage);
  const rebate = med((s) => s.rebate);
  const netMist = computation + storage - rebate;
  return { computation, storage, rebate, netMist, netSui: netMist / MIST_PER_SUI };
}

async function runGas(
  client: SuiClient,
  signer: Ed25519Keypair,
  args: ProbeArgs,
): Promise<GasSection> {
  const opens: NetGas[] = [];
  const closes: NetGas[] = [];
  for (let i = 0; i < args.samples; i++) {
    const seats = makeSeats(randomUUID(), { a: args.stakeMist, b: args.stakeMist }, 0n);
    const res = await openBatch(client, signer, [openSpec(seats)], {
      gasBudgetMist: budgetForOpen(args, 1),
      coinType: args.coinType,
    });
    opens.push(netGas(res.gasUsed));
    const tunnelId = res.ids[0];
    const createdAt = await readCreatedAt(client, tunnelId);
    const settlement = buildOpeningSettlement(seats, tunnelId, createdAt);
    closes.push(await closeOneCaptureGas(client, signer, { tunnelId, settlement }, args));
  }
  const openMist = medianLine(opens);
  const closeMist = medianLine(closes);
  return {
    openMist,
    closeMist,
    vsTestnet: {
      openDeltaSui: openMist.netSui - OPEN_TESTNET_SUI,
      closeDeltaSui: closeMist.netSui - CLOSE_TESTNET_SUI,
    },
  };
}

// ── orchestration ─────────────────────────────────────────────────────────────

function stamp(): string {
  // YYYYMMDD-HHMMSS in local time; no filename-breaking separators.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

const jsonReplacer = (_k: string, v: unknown) =>
  typeof v === "bigint" ? v.toString() : v;

export async function runProbe(argv: string[]): Promise<string> {
  const args = parseProbeArgs(argv);
  if (args.coinType !== SUI_COIN_TYPE) {
    throw new Error(
      `--coin-type ${args.coinType} unsupported: the stock 'bun run stack' mints only SUI, ` +
        `and batch opens split stakes off the gas coin (Coin<SUI>). Use SUI.`,
    );
  }
  const envLocal = readEnvLocal();
  const rpcUrl = resolveRpcUrl(args, envLocal);
  const packageId = resolvePackageId(args, envLocal);
  // Set BEFORE building any tx so the reused buildTarget resolves the package.
  process.env.PACKAGE_ID = packageId;
  const settler = resolveSettler(args, envLocal);
  const client = new SuiClient({ url: rpcUrl });
  const refGasPriceMist = String(await client.getReferenceGasPrice());

  const all = args.phase === "all";
  let opensPerPtb: OpensPerPtb | null = null;
  let closesPerPtb: ClosesPerPtb | null = null;
  let throughput: Throughput | null = null;
  let gas: GasSection | null = null;
  let poolSizeUsed = 0;

  if (all || args.phase === "open-knee") {
    opensPerPtb = await runOpenKnee(client, settler, args);
  }
  if (all || args.phase === "close-knee") {
    closesPerPtb = await runCloseKnee(client, settler, args);
  }
  if (all || args.phase === "throughput") {
    const pool = loadPool(args);
    const r = await runThroughput(client, pool, args);
    throughput = r.throughput;
    poolSizeUsed = r.poolSizeUsed;
  }
  if (all || args.phase === "gas") {
    gas = await runGas(client, settler, args);
  }

  const env = envName();
  const meta: ProbeMeta = {
    env,
    rpcUrl,
    packageId,
    coinType: args.coinType,
    refGasPriceMist,
    startedAtIso: new Date().toISOString(),
    poolSize: poolSizeUsed,
    stakeMist: Number(args.stakeMist),
    samples: args.samples,
  };
  const derived: Derived = {
    netSuiPerTunnel: (gas?.openMist.netSui ?? 0) + (gas?.closeMist.netSui ?? 0),
    tunnelsSettledPerSec: throughput ? throughput.closeCeilingPerSec : null,
  };
  const report: ProbeReport = { meta, opensPerPtb, closesPerPtb, throughput, gas, derived };

  const dir = join(import.meta.dir, "..", "reports");
  mkdirSync(dir, { recursive: true });
  const jsonPath = args.out
    ? resolve(process.cwd(), args.out)
    : join(dir, probeBasename(env, stamp(), "json"));
  const mdPath = jsonPath.endsWith(".json") ? jsonPath.slice(0, -5) + ".md" : jsonPath + ".md";
  writeFileSync(jsonPath, JSON.stringify(report, jsonReplacer, 2) + "\n");
  writeFileSync(mdPath, renderProbeMarkdown(report));

  process.stdout.write(renderProbeSummary(report) + "\n");
  process.stdout.write(`[localnet/probe] report: ${jsonPath}\n`);
  process.stdout.write(`[localnet/probe] markdown: ${mdPath}\n`);
  return jsonPath;
}
