// Generate N agent keypairs and fund each from the treasury in ONE PTB (splitCoins -> transfer).
// Writes keys.json: [{ address, secretKey }] where secretKey is the Bech32 suiprivkey1… form.
// Run (key never printed):
//   SUI_TREASURY_KEY=$(sui keytool export --key-identity "$(sui client active-address)" --json \
//     | jq -r .exportedPrivateKey) N=2 node agent/fundTreasury.mjs
import { writeFileSync } from "node:fs";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

const N = Number(process.env.N ?? 2);
const PER = BigInt(process.env.PER_MIST ?? 100_000_000); // gas + stake headroom per agent (0.1 SUI)
if (!process.env.SUI_TREASURY_KEY) {
  throw new Error("set SUI_TREASURY_KEY (suiprivkey1… via `sui keytool export`)");
}

const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl("testnet") });
const treasury = Ed25519Keypair.fromSecretKey(process.env.SUI_TREASURY_KEY);
console.log(`treasury ${treasury.getPublicKey().toSuiAddress()} funding ${N} agents @ ${PER} MIST`);

const agents = Array.from({ length: N }, () => {
  const kp = new Ed25519Keypair();
  return { address: kp.getPublicKey().toSuiAddress(), secretKey: kp.getSecretKey() };
});

const tx = new Transaction();
const coins = tx.splitCoins(
  tx.gas,
  agents.map(() => tx.pure.u64(PER)),
);
agents.forEach((a, i) => tx.transferObjects([coins[i]], tx.pure.address(a.address)));

const res = await client.signAndExecuteTransaction({
  signer: treasury,
  transaction: tx,
  options: { showEffects: true },
});
await client.waitForTransaction({ digest: res.digest });
if (res.effects?.status?.status !== "success") {
  throw new Error(`fan-out failed: ${res.effects?.status?.error}`);
}

writeFileSync(new URL("./keys.json", import.meta.url), JSON.stringify(agents, null, 2));
console.log(`funded ${N} agents | digest ${res.digest}`);
