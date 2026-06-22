// Top up the agent wallet pool to a TARGET count (N) from the treasury in ONE PTB, preserving
// any already-funded wallets in keys.json so re-runs reuse them (no wasted SUI). keys.json holds
// [{ address, secretKey }] where secretKey is the Bech32 suiprivkey1… form.
// Run (key never printed):
//   SUI_TREASURY_KEY=$(sui keytool export --key-identity "$(sui client active-address)" --json \
//     | jq -r .exportedPrivateKey) N=10 node agent/fundTreasury.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

const N = Number(process.env.N ?? 2); // TARGET total wallet count
const PER = BigInt(process.env.PER_MIST ?? 100_000_000); // gas + stake headroom per new wallet (0.1 SUI)
if (!process.env.SUI_TREASURY_KEY) {
  throw new Error("set SUI_TREASURY_KEY (suiprivkey1… via `sui keytool export`)");
}

const keysPath = new URL("./keys.json", import.meta.url);
const existing = existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, "utf8")) : [];
const want = N - existing.length;
if (want <= 0) {
  console.log(`already have ${existing.length} agent wallet(s) >= ${N}; reusing keys.json, no funding`);
  process.exit(0);
}

const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl("testnet") });
const treasury = Ed25519Keypair.fromSecretKey(process.env.SUI_TREASURY_KEY);
console.log(
  `treasury ${treasury.getPublicKey().toSuiAddress()} topping up ${existing.length} -> ${N} (funding ${want} new @ ${PER} MIST)`,
);

const fresh = Array.from({ length: want }, () => {
  const kp = new Ed25519Keypair();
  return { address: kp.getPublicKey().toSuiAddress(), secretKey: kp.getSecretKey() };
});

const tx = new Transaction();
const coins = tx.splitCoins(
  tx.gas,
  fresh.map(() => tx.pure.u64(PER)),
);
fresh.forEach((a, i) => tx.transferObjects([coins[i]], tx.pure.address(a.address)));

const res = await client.signAndExecuteTransaction({
  signer: treasury,
  transaction: tx,
  options: { showEffects: true },
});
await client.waitForTransaction({ digest: res.digest });
if (res.effects?.status?.status !== "success") {
  throw new Error(`fan-out failed: ${res.effects?.status?.error}`);
}

writeFileSync(keysPath, JSON.stringify([...existing, ...fresh], null, 2));
console.log(`funded ${want} new agent wallets (total ${N}) | digest ${res.digest}`);
