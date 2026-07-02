/**
 * Minimal end-to-end smoke for the SIP-58 address-balance path, BEFORE the throughput probe.
 *
 * Validates the three things that were "e2e-deferred (no live node)" in the backend settler:
 *   1. a client-built tx with EMPTY gas payment + `ValidDuring` builds (SDK doesn't auto-resolve gas)
 *   2. the node ACCEPTS address-balance gas (FundsWithdrawal for gas from the settler's balance)
 *   3. `coin::redeem_funds(tx.withdrawal(...))` funds an open's stake from the same balance
 *
 * One open + one close, both settler-signed (the settler is sender + gas owner + stake funder; the
 * bots are genuine parties whose keys sit in the tunnel and co-sign the close settlement off-chain).
 * If this lands, the whole address-balance rerun is unblocked.
 *
 * Run: `bun run src/sip58Smoke.ts` from tools/loadbench (after `bun run stack`).
 * Key-safety: the settler secret is read from .env.local by NAME and never printed.
 */

import { readFileSync } from "node:fs";
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
} from "./onchain2x";
import { makeSeats } from "./match";
import { openSpec } from "./onchain";
import { buildOpeningSettlement } from "./probeClose";

/** Parse a dotenv-style file into a plain record (KEY=VALUE, `#` comments, no quoting). */
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
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

async function main() {
  const env = parseEnvLocal(new URL("../.env.local", import.meta.url).pathname);
  const rpc = env.SUI_RPC_URL ?? process.env.SUI_RPC_URL;
  const pkg = env.PACKAGE_ID ?? env.TUNNEL_PACKAGE_ID ?? process.env.PACKAGE_ID;
  const keyVal = env.SUI_SETTLER_KEY ?? process.env.SUI_SETTLER_KEY; // by name; never printed
  if (!rpc || !pkg || !keyVal)
    throw new Error("need SUI_RPC_URL, PACKAGE_ID, SUI_SETTLER_KEY in .env.local (run 'bun run stack')");
  process.env.PACKAGE_ID = pkg; // onchain2x.buildTarget reads this

  const client = new SuiClient({ url: rpc });
  const settler = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(keyVal).secretKey);
  const settlerAddr = settler.toSuiAddress();
  const chain = await genesisDigest(client);
  console.log(`smoke: rpc=${rpc} pkg=${pkg.slice(0, 10)}… settler=${settlerAddr.slice(0, 10)}… chain=${chain}`);

  // Fund the settler's SUI address balance for both gas and stakes.
  const STAKE = 1_000n; // tiny per-seat stake
  await ensureAddressBalance(client, settler, settlerAddr, 10_000_000_000n); // 10 SUI buffer
  console.log("smoke: settler address balance funded");

  // ---- OPEN one tunnel via SIP-58 (stake from balance + address-balance gas) ----
  const seats = makeSeats("sip58-smoke", { a: STAKE, b: STAKE }, 0n);
  const spec = openSpec(seats);
  const { epoch, gasPrice } = await epochInfo(client);
  const openTx = new Transaction();
  const stakeCoin = redeemStakeFromBalance(openTx, STAKE * 2n, SUI_COIN_TYPE);
  buildOpenAndFundMany(openTx, [spec], SUI_COIN_TYPE, stakeCoin);
  consumeZeroRemainder(openTx, stakeCoin, SUI_COIN_TYPE);
  applyAddressBalanceGas(openTx, {
    sender: settlerAddr,
    owner: settlerAddr,
    budgetMist: 100_000_000,
    gasPrice,
    epoch,
    chainDigest: chain,
    nonce: nextNonce(),
  });
  const openRes = await submitAddressBalance(client, settler, openTx, { waitForFinality: true });
  const ids = getCreatedObjectIds(openRes.objectChanges, "::tunnel::Tunnel<");
  if (ids.length !== 1) throw new Error(`expected 1 tunnel, got ${ids.length}`);
  const tunnelId = ids[0];
  console.log(`smoke: OPEN ok — tunnel ${tunnelId.slice(0, 12)}… digest ${openRes.digest}`);

  // ---- CLOSE it via SIP-58 (settler-signed; bot co-sigs are inside the settlement) ----
  // Read-after-write: WaitForLocalExecution certifies the open but the shared object can lag the
  // object store, so resolving it as a close input races ("does not exist"). Wait for finality, then
  // poll until the tunnel is queryable; created_at also bounds the settlement timestamp.
  await client.waitForTransaction({ digest: openRes.digest });
  let createdAt = 0n;
  for (let i = 0; i < 40; i++) {
    const obj = await client.getObject({ id: tunnelId, options: { showContent: true } });
    const ca = (obj.data?.content as { fields?: { created_at?: string | number } } | undefined)
      ?.fields?.created_at;
    if (obj.data && ca != null) {
      createdAt = BigInt(ca);
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (createdAt === 0n) throw new Error(`tunnel ${tunnelId} not queryable after open`);
  const settlement = buildOpeningSettlement(seats, tunnelId, createdAt);
  const closeTx = new Transaction();
  buildCloseWithRootFromSettlement(closeTx, tunnelId, settlement, SUI_COIN_TYPE);
  const ei2 = await epochInfo(client);
  applyAddressBalanceGas(closeTx, {
    sender: settlerAddr,
    owner: settlerAddr,
    budgetMist: 100_000_000,
    gasPrice: ei2.gasPrice,
    epoch: ei2.epoch,
    chainDigest: chain,
    nonce: nextNonce(),
  });
  const closeRes = await submitAddressBalance(client, settler, closeTx, { waitForFinality: true });
  console.log(`smoke: CLOSE ok — digest ${closeRes.digest}`);
  console.log("SIP58_SMOKE_OK");
}

main().catch((e) => {
  console.error("SIP58_SMOKE_FAIL", e?.message ?? e);
  process.exit(1);
});
