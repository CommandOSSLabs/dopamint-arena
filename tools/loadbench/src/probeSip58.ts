/**
 * SIP-58 address-balance throughput probe: re-run the open/close experiment with gas (and the open
 * stake) drawn from the settler's address balance instead of owned coins.
 *
 * The owned-coin probe was capped two ways: (1) a stale-gas/version race under rapid submission
 * (the fullnode's owned-object index lags, so the next tx picks a stale coin version → "unavailable
 * for consumption"), forcing rebuild-and-retry; (2) concurrency limited to the funded signer-pool
 * size, since one coin can't back two in-flight txs. SIP-58 removes BOTH: with empty gas payment +
 * `ValidDuring`, gas is a FundsWithdrawal from the settler's address balance — no coin object to
 * lock — so ONE settler fires unlimited concurrent txs and never equivocates. The open's stake is
 * likewise withdrawn from the balance (`coin::redeem_funds`), so opens have no owned coin either.
 *
 * The settler is sender + gas owner + stake funder for every tx; the bots stay genuine parties
 * (their keys are in each tunnel and co-sign the close settlement off-chain) — only on-chain
 * submission is settler-driven, which is exactly the production sponsor model.
 *
 * Headline measurement: accepted opens/s and closes/s as concurrency K scales, and the equivocation
 * count (expected ZERO — the property the owned-coin path could not achieve).
 *
 * Run: `bun run src/probeSip58.ts [--n 2000] [--open-batch 128] [--close-batch 512]
 *       [--concurrency 16] [--stake 1000] [--settler-key-env SUI_SETTLER_KEY]` from tools/loadbench
 *       (after `bun run stack`). Key-safety: the settler secret is read by env NAME, never printed.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "./suiClient";
import {
  SUI_COIN_TYPE,
  redeemStakeFromBalance,
  buildOpenAndFundMany,
  buildCloseWithRootFromSettlement,
  consumeZeroRemainder,
  applyAddressBalanceGas,
  submitAddressBalance,
  ensureAddressBalance,
  getCreatedObjectIds,
  epochInfo,
  genesisDigest,
  nextNonce,
  type ExecResult,
} from "./onchain2x";
import { makeSeats, type Seats } from "./match";
import { openSpec } from "./onchain";
import { buildOpeningSettlement, type CloseTarget } from "./probeClose";
import { gasBudgetFor } from "./probeLimits";
import { isRetriableTxError } from "./probeRetry";

interface Sip58Args {
  rpcUrl?: string;
  packageId?: string;
  settlerKeyEnv: string;
  n: number;
  openBatch: number;
  closeBatch: number;
  concurrency: number;
  stakeMist: bigint;
  fundSui: number;
}

function parseArgs(argv: string[]): Sip58Args {
  const a: Sip58Args = {
    settlerKeyEnv: "SUI_SETTLER_KEY",
    n: 2000,
    openBatch: 128,
    closeBatch: 512,
    concurrency: 16,
    stakeMist: 1000n,
    fundSui: 50,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--rpc-url": a.rpcUrl = v; i++; break;
      case "--package-id": a.packageId = v; i++; break;
      case "--settler-key-env": a.settlerKeyEnv = v; i++; break;
      case "--n": a.n = Number(v); i++; break;
      case "--open-batch": a.openBatch = Number(v); i++; break;
      case "--close-batch": a.closeBatch = Number(v); i++; break;
      case "--concurrency": a.concurrency = Number(v); i++; break;
      case "--stake": a.stakeMist = BigInt(v); i++; break;
      case "--fund-sui": a.fundSui = Number(v); i++; break;
    }
  }
  return a;
}

function parseEnvLocal(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/** Split `items` into `k` round-robin lanes (lane i gets items i, i+k, i+2k, …). */
function lanes<T>(items: T[], k: number): T[][] {
  const out: T[][] = Array.from({ length: Math.max(1, Math.min(k, items.length)) }, () => []);
  items.forEach((it, i) => out[i % out.length].push(it));
  return out;
}

interface PhaseResult {
  accepted: number;
  errors: number;
  equivocations: number;
  ptbs: number;
  ptbErrors: number;
  wallMs: number;
  opsPerSec: number;
}

/** Classify + count a submission error: equivocation/version (the owned-coin failure mode) vs other. */
function tallyError(e: unknown, out: { errors: number; equivocations: number }, count: number): void {
  out.errors += count;
  if (isRetriableTxError(e)) out.equivocations += count;
}

/** One open batch: stake total withdrawn from the settler's balance, split per seat, address-balance
 *  gas. Returns the created tunnel ids (objectChanges order — matched to seats during staging). */
async function submitOpenBatch(
  client: SuiClient,
  settler: Ed25519Keypair,
  settlerAddr: string,
  chain: string,
  epoch: number,
  gasPrice: number,
  specs: ReturnType<typeof openSpec>[],
  stakeMist: bigint,
): Promise<ExecResult> {
  const tx = new Transaction();
  const total = stakeMist * 2n * BigInt(specs.length);
  const stakeCoin = redeemStakeFromBalance(tx, total, SUI_COIN_TYPE);
  buildOpenAndFundMany(tx, specs, SUI_COIN_TYPE, stakeCoin);
  consumeZeroRemainder(tx, stakeCoin, SUI_COIN_TYPE);
  applyAddressBalanceGas(tx, {
    sender: settlerAddr,
    owner: settlerAddr,
    budgetMist: gasBudgetFor(specs.length),
    gasPrice,
    epoch,
    chainDigest: chain,
    nonce: nextNonce(),
  });
  return submitAddressBalance(client, settler, tx);
}

interface OpenedBatch {
  seats: Seats[];
  createdIds: string[];
  digest: string;
}

async function runOpenPhase(
  client: SuiClient,
  settler: Ed25519Keypair,
  settlerAddr: string,
  chain: string,
  args: Sip58Args,
): Promise<{ phase: PhaseResult; opened: OpenedBatch[] }> {
  // Pre-build all seats + specs (off-chain, untimed), then chunk into open-batch PTBs.
  const allSeats: Seats[] = Array.from({ length: args.n }, (_, i) =>
    makeSeats(`sip58-${i}`, { a: args.stakeMist, b: args.stakeMist }, 0n),
  );
  const batches: Seats[][] = [];
  for (let i = 0; i < allSeats.length; i += args.openBatch)
    batches.push(allSeats.slice(i, i + args.openBatch));

  const { epoch, gasPrice } = await epochInfo(client);
  const opened: OpenedBatch[] = [];
  const tally = { accepted: 0, errors: 0, equivocations: 0, ptbs: 0, ptbErrors: 0 };

  const t0 = performance.now();
  await Promise.all(
    lanes(batches, args.concurrency).map(async (lane) => {
      for (const batchSeats of lane) {
        const specs = batchSeats.map(openSpec);
        try {
          const res = await submitOpenBatch(
            client, settler, settlerAddr, chain, epoch, gasPrice, specs, args.stakeMist,
          );
          const ids = getCreatedObjectIds(res.objectChanges, "::tunnel::Tunnel<");
          tally.accepted += ids.length;
          tally.ptbs += 1;
          opened.push({ seats: batchSeats, createdIds: ids, digest: res.digest });
        } catch (e) {
          tally.ptbErrors += 1;
          tallyError(e, tally, batchSeats.length);
        }
      }
    }),
  );
  const wallMs = performance.now() - t0;
  return {
    phase: { ...tally, wallMs, opsPerSec: (tally.accepted / wallMs) * 1000 },
    opened,
  };
}

/** Stage close targets (untimed): match each created tunnel to its seat by on-chain party_a address
 *  (batch-open returns ids in objectChanges order, not spec order), reading created_at for the
 *  settlement timestamp. multiGetObjects keeps this to a few RPCs per batch. */
async function stageCloseTargets(
  client: SuiClient,
  opened: OpenedBatch[],
): Promise<CloseTarget[]> {
  // Read-after-write: the open phase submits without awaiting finality (throughput), so the created
  // shared objects can lag the object store. Wait for each open tx before resolving its tunnels.
  await Promise.all(
    opened.map((b) => client.waitForTransaction({ digest: b.digest }).catch(() => {})),
  );
  const MULTIGET_MAX = 50; // sui_multiGetObjects caps at 50 ids/call
  const targets: CloseTarget[] = [];
  for (const b of opened) {
    if (b.createdIds.length === 0) continue;
    const byPartyA = new Map(b.seats.map((s) => [s.partyA.address.toLowerCase(), s]));
    for (let off = 0; off < b.createdIds.length; off += MULTIGET_MAX) {
      const idChunk = b.createdIds.slice(off, off + MULTIGET_MAX);
      const objs = await client.multiGetObjects({ ids: idChunk, options: { showContent: true } });
      for (let i = 0; i < objs.length; i++) {
        const fields = (
          objs[i].data?.content as
            | { fields?: { created_at?: string | number; party_a?: { fields?: { address?: string } } } }
            | undefined
        )?.fields;
        const partyAAddr = fields?.party_a?.fields?.address?.toLowerCase();
        const seat = partyAAddr ? byPartyA.get(partyAAddr) : undefined;
        if (!seat) continue; // unresolved tunnel — skip (counted via accepted vs staged delta)
        const tunnelId = idChunk[i];
        const settlement = buildOpeningSettlement(seat, tunnelId, BigInt(fields?.created_at ?? 0));
        targets.push({ tunnelId, settlement });
      }
    }
  }
  return targets;
}

async function runClosePhase(
  client: SuiClient,
  settler: Ed25519Keypair,
  settlerAddr: string,
  chain: string,
  targets: CloseTarget[],
  args: Sip58Args,
): Promise<PhaseResult> {
  const batches: CloseTarget[][] = [];
  for (let i = 0; i < targets.length; i += args.closeBatch)
    batches.push(targets.slice(i, i + args.closeBatch));

  const { epoch, gasPrice } = await epochInfo(client);
  const tally = { accepted: 0, errors: 0, equivocations: 0, ptbs: 0, ptbErrors: 0 };

  const t0 = performance.now();
  await Promise.all(
    lanes(batches, args.concurrency).map(async (lane) => {
      for (const chunk of lane) {
        const tx = new Transaction();
        for (const t of chunk)
          buildCloseWithRootFromSettlement(tx, t.tunnelId, t.settlement, SUI_COIN_TYPE);
        applyAddressBalanceGas(tx, {
          sender: settlerAddr,
          owner: settlerAddr,
          budgetMist: gasBudgetFor(chunk.length),
          gasPrice,
          epoch,
          chainDigest: chain,
          nonce: nextNonce(),
        });
        try {
          await submitAddressBalance(client, settler, tx);
          tally.accepted += chunk.length;
          tally.ptbs += 1;
        } catch (e) {
          tally.ptbErrors += 1;
          tallyError(e, tally, chunk.length);
        }
      }
    }),
  );
  const wallMs = performance.now() - t0;
  return { ...tally, wallMs, opsPerSec: (tally.accepted / wallMs) * 1000 };
}

function fmt(p: PhaseResult): string {
  return (
    `accepted=${p.accepted} (${p.opsPerSec.toFixed(1)}/s over ${(p.wallMs / 1000).toFixed(2)}s) ` +
    `ptbs=${p.ptbs} ptbErr=${p.ptbErrors} err=${p.errors} equivocations=${p.equivocations}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = parseEnvLocal(new URL("../.env.local", import.meta.url).pathname);
  const rpc = args.rpcUrl ?? env.SUI_RPC_URL ?? process.env.SUI_RPC_URL;
  const pkg = args.packageId ?? env.PACKAGE_ID ?? env.TUNNEL_PACKAGE_ID ?? process.env.PACKAGE_ID;
  const keyVal = process.env[args.settlerKeyEnv] ?? env[args.settlerKeyEnv]; // by NAME; never printed
  if (!rpc || !pkg)
    throw new Error("need SUI_RPC_URL + PACKAGE_ID (run 'bun run stack' to write .env.local)");
  if (!keyVal)
    throw new Error(
      `settler key not found: set $${args.settlerKeyEnv} or add it to .env.local. ` +
        `The probe reads the key by env NAME and never accepts it on argv.`,
    );
  process.env.PACKAGE_ID = pkg; // onchain2x.buildTarget reads this

  const client = new SuiClient({ url: rpc });
  const settler = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(keyVal).secretKey);
  const settlerAddr = settler.toSuiAddress();
  const chain = await genesisDigest(client);

  console.log(
    `sip58 probe: n=${args.n} open-batch=${args.openBatch} close-batch=${args.closeBatch} ` +
      `K=${args.concurrency} stake=${args.stakeMist} settler=${settlerAddr.slice(0, 10)}…`,
  );
  // Fund the settler's address balance for gas + all stakes (one bootstrap deposit).
  await ensureAddressBalance(client, settler, settlerAddr, BigInt(args.fundSui) * 1_000_000_000n);
  console.log(`funded settler address balance (~${args.fundSui} SUI). opening…`);

  const { phase: openP, opened } = await runOpenPhase(client, settler, settlerAddr, chain, args);
  console.log(`OPEN:  ${fmt(openP)}`);

  const targets = await stageCloseTargets(client, opened);
  console.log(`staged ${targets.length} close targets (from ${openP.accepted} opened). closing…`);

  const closeP = await runClosePhase(client, settler, settlerAddr, chain, targets, args);
  console.log(`CLOSE: ${fmt(closeP)}`);

  const report = {
    when: new Date().toISOString(),
    network: rpc,
    chainDigest: chain,
    args: { ...args, stakeMist: args.stakeMist.toString() },
    open: openP,
    close: closeP,
    baselineOwnedCoin: { opensPerSec: 425, closesPerSec: 110, pool: 8 },
  };
  mkdirSync(new URL("../reports", import.meta.url).pathname, { recursive: true });
  const path = new URL(`../reports/sip58-${Date.now()}.json`, import.meta.url).pathname;
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`report → ${path}`);
  console.log("SIP58_PROBE_OK");
}

main().catch((e) => {
  console.error("SIP58_PROBE_FAIL", e?.message ?? e);
  process.exit(1);
});
