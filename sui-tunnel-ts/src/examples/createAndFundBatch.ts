/**
 * ===== Dopamint extension (not upstream sui-tunnel) =====
 *
 * Live on-chain harness for the `create_and_fund` funding model — the tier the unit tests
 * can't reach: PTB composition + single-wallet `splitCoins` funding and the cooperative
 * settle path on a real VM. Not a unit test (per onchain/lifecycle.ts, live-network code is
 * exercised here, not under `pnpm test`). Run after publishing the package:
 *
 *   PACKAGE_ID=0x<pkg> SUI_NETWORK=localnet node --import tsx src/examples/createAndFundBatch.ts
 *
 * Funder: PRIVATE_KEY (bech32 suiprivkey…) if set, else a fresh faucet-funded key. Stakes are
 * dust (MIST), so funds stranding on the ephemeral party addresses after settle is negligible.
 */

import { SuiClient } from "@mysten/sui/client";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { getNetwork, TunnelStatus } from "../config";
import { blake2b256 } from "../core/crypto";
import { createParticipant, Participant } from "../core/keys";
import { CoSignedSettlementWithRoot, OffchainTunnel } from "../core/tunnel";
import { buildOpenAndFundMany, TunnelOpenSpec } from "../onchain/createAndFund";
import { execute } from "../onchain/lifecycle";
import { buildCloseWithRootFromSettlement } from "../onchain/txbuilders";
import { PaymentsProtocol } from "../protocol/payments";
import {
  createSuiClient,
  getCreatedObjectIds,
  getKeypairFromEnv,
  getObjects,
} from "../utils";

interface Game {
  a: Participant;
  b: Participant;
  aAmount: bigint;
  bAmount: bigint;
  spec: TunnelOpenSpec;
  tunnelId?: string;
  createdAt?: bigint;
  settlement?: CoSignedSettlementWithRoot;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normAddr(a: string): string {
  return "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** RPC moveObject fields for a Tunnel<T>, with the bits this harness reads. */
function tunnelFields(obj: unknown): {
  status: number;
  createdAt: bigint;
  partyA: string;
} {
  const f = (obj as { content?: { fields?: Record<string, any> } })?.content
    ?.fields;
  if (!f) throw new Error("object has no moveObject fields");
  return {
    status: Number(f.status),
    createdAt: BigInt(f.created_at),
    partyA: normAddr(f.party_a.fields.address),
  };
}

async function resolveFunder(
  client: SuiClient,
  network: string
): Promise<Ed25519Keypair> {
  if (process.env.PRIVATE_KEY) return getKeypairFromEnv("PRIVATE_KEY");
  if (network === "mainnet") {
    throw new Error("set PRIVATE_KEY: no faucet for mainnet");
  }
  const kp = new Ed25519Keypair();
  const recipient = kp.toSuiAddress();
  console.log(`  funder (faucet): ${recipient}`);
  await requestSuiFromFaucetV2({
    host: getFaucetHost(network as any),
    recipient,
  });
  for (let i = 0; i < 30; i++) {
    const { totalBalance } = await client.getBalance({ owner: recipient });
    if (BigInt(totalBalance) > 0n) return kp;
    await sleep(1000);
  }
  throw new Error(`faucet did not fund ${recipient} within 30s`);
}

function buildGames(n: number): Game[] {
  const games: Game[] = [];
  for (let i = 0; i < n; i++) {
    const a = createParticipant(`game-${i}-A`);
    const b = createParticipant(`game-${i}-B`);
    // Distinct per-tunnel stakes (MIST): makes a settled-split / cross-wiring error visible.
    const aAmount = BigInt(1000 * (i + 1));
    const bAmount = BigInt(250 * (i + 1));
    games.push({
      a,
      b,
      aAmount,
      bAmount,
      spec: {
        partyA: {
          address: a.address,
          publicKey: a.keyPair.publicKey,
          signatureType: a.keyPair.scheme,
        },
        partyB: {
          address: b.address,
          publicKey: b.keyPair.publicKey,
          signatureType: b.keyPair.scheme,
        },
        aAmount,
        bAmount,
        timeoutMs: 3_600_000n,
      },
    });
  }
  return games;
}

/** Co-sign one tunnel's settlement: run one A→B payment, anchor a 32-byte root. */
function buildSettlement(g: Game): CoSignedSettlementWithRoot {
  const t = OffchainTunnel.selfPlay(
    new PaymentsProtocol(),
    g.tunnelId!,
    g.a.keyPair,
    g.b.keyPair,
    g.a.address,
    g.b.address,
    { a: g.aAmount, b: g.bAmount }
  );
  // One real off-chain transition so the settled split differs from the deposit split.
  const pay = g.aAmount / 2n;
  if (pay > 0n)
    t.step({ from: "A", amount: pay }, "A", { timestamp: g.createdAt! });
  // Stand-in for proof/transcript.ts Transcript.root() (Walrus anchor); Move only checks len==32.
  const root = blake2b256(new TextEncoder().encode(`dopamint:${g.tunnelId}`));
  // created_at as the settlement timestamp satisfies the on-chain `created_at <= ts <= now`
  // bounds without any local-vs-chain clock skew. onchainNonce=0 (no on-chain update_state).
  return t.buildSettlementWithRoot(g.createdAt!, root, 0n);
}

async function main(): Promise<void> {
  if (!process.env.PACKAGE_ID) {
    console.error(
      "PACKAGE_ID not set. Publish the package first, then re-run:\n" +
        "  cd sui_tunnel && sui client publish --gas-budget 200000000\n" +
        "  PACKAGE_ID=0x<pkg> SUI_NETWORK=localnet node --import tsx src/examples/createAndFundBatch.ts"
    );
    process.exit(1);
  }
  // Each tunnel adds one splitCoins output + one moveCall to the open PTB, so a large TUNNELS
  // will eventually hit the PTB command/argument ceilings; the default (5) is well within them.
  const n = Number(process.env.TUNNELS ?? "5");
  const network = getNetwork();
  const client = createSuiClient(network);
  console.log(
    `create_and_fund batch harness — network=${network}, tunnels=${n}`
  );

  const funder = await resolveFunder(client, network);
  const games = buildGames(n);

  // ---- 1. OPEN: N tunnels in one PTB ----
  const openTx = new Transaction();
  buildOpenAndFundMany(
    openTx,
    games.map((g) => g.spec)
  );
  const open = await execute(client, funder, openTx, { waitForFinality: true });
  const ids = getCreatedObjectIds(
    open.objectChanges as any[],
    "::tunnel::Tunnel<"
  );
  console.log(`  OPEN  digest=${open.digest}  created ${ids.length} tunnel(s)`);
  if (ids.length !== n) {
    throw new Error(`expected ${n} tunnels created, got ${ids.length}`);
  }

  // Map on-chain tunnels back to games by party A address (objectChanges order is unspecified).
  const objs = await getObjects(client, ids);
  const byPartyA = new Map<
    string,
    { id: string; status: number; createdAt: bigint }
  >();
  for (let i = 0; i < objs.length; i++) {
    const f = tunnelFields(objs[i]);
    byPartyA.set(f.partyA, {
      id: ids[i],
      status: f.status,
      createdAt: f.createdAt,
    });
  }
  const failures: string[] = [];
  for (const g of games) {
    const hit = byPartyA.get(normAddr(g.a.address));
    if (!hit) {
      failures.push(`no on-chain tunnel for party A ${g.a.address}`);
      continue;
    }
    g.tunnelId = hit.id;
    g.createdAt = hit.createdAt;
    if (hit.status !== TunnelStatus.ACTIVE) {
      failures.push(`tunnel ${hit.id} status ${hit.status} != ACTIVE`);
    }
  }
  console.log(
    `  ACTIVE check: ${n - failures.length}/${n} active` +
      (failures.length ? ` — ${failures.length} issue(s)` : "")
  );

  // ---- 2. PLAY + 3. SETTLE: co-sign each, then close all in one PTB ----
  const settleable = games.filter((g) => g.tunnelId);
  for (const g of settleable) g.settlement = buildSettlement(g);

  const settleTx = new Transaction();
  for (const g of settleable) {
    buildCloseWithRootFromSettlement(settleTx, g.tunnelId!, g.settlement!);
  }
  try {
    const settle = await execute(client, funder, settleTx, {
      waitForFinality: true,
    });
    console.log(
      `  SETTLE digest=${settle.digest}  closed ${settleable.length} in one PTB`
    );
  } catch (e) {
    // The batch PTB is atomic: one bad close aborts all. Fall back to per-tunnel closes so a
    // single failure can't strand the rest open (don't-leave-them-open teardown).
    console.warn(
      `  batch settle failed (${(e as Error).message}); closing individually`
    );
    for (const g of settleable) {
      try {
        const tx = new Transaction();
        buildCloseWithRootFromSettlement(tx, g.tunnelId!, g.settlement!);
        await execute(client, funder, tx, { waitForFinality: true });
      } catch (err) {
        failures.push(`close ${g.tunnelId} failed: ${(err as Error).message}`);
      }
    }
  }

  // ---- verify terminal state ----
  const after = await getObjects(
    client,
    settleable.map((g) => g.tunnelId!)
  );
  let closed = 0;
  for (const o of after) {
    if (tunnelFields(o).status === TunnelStatus.CLOSED) closed++;
    else failures.push(`tunnel ${(o as any).objectId} not CLOSED after settle`);
  }
  console.log(`  CLOSED check: ${closed}/${settleable.length} closed`);

  if (failures.length) {
    console.error(`\nFAIL (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nOK — opened+funded+activated and settled ${n} tunnels in 2 signed txs.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
