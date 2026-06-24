import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiClient } from "@mysten/sui/client";
import type { ChatAgentConfig } from "./config.ts";

export const DOPAMINT_DECIMALS = 9;

export function stakeToRaw(whole: bigint): bigint {
  return whole * 10n ** BigInt(DOPAMINT_DECIMALS);
}

export function buildDopamintFaucetTx(
  tx: Transaction,
  cfg: ChatAgentConfig,
  recipient: string,
  amount: bigint,
): void {
  tx.moveCall({
    target: `${cfg.dopamintPackageId}::dopamint::mint`,
    arguments: [
      tx.object(cfg.dopamintFaucetId),
      tx.pure.u64(amount),
      tx.pure.address(recipient),
    ],
  });
}

export async function ensureDopamintBalance(
  client: SuiClient,
  cfg: ChatAgentConfig,
  operatorKeypair: Ed25519Keypair,
  need: bigint,
): Promise<void> {
  const owner = operatorKeypair.getPublicKey().toSuiAddress();
  const { totalBalance } = await client.getBalance({
    owner,
    coinType: cfg.dopamintCoinType,
  });
  if (BigInt(totalBalance) >= need) return;
  const faucetAmount = stakeToRaw(10_000n);
  const tx = new Transaction();
  buildDopamintFaucetTx(tx, cfg, owner, faucetAmount);
  const res = await client.signAndExecuteTransaction({
    signer: operatorKeypair,
    transaction: tx,
    options: { showEffects: true },
  });
  await client.waitForTransaction({ digest: res.digest });
}

export async function getStakeCoin(
  client: SuiClient,
  cfg: ChatAgentConfig,
  owner: string,
  need: bigint,
): Promise<string> {
  const coins = await client.getCoins({ owner, coinType: cfg.dopamintCoinType });
  const coin = coins.data.find((c) => BigInt(c.balance) >= need);
  if (!coin) throw new Error("no DOPAMINT coin large enough to stake");
  return coin.coinObjectId;
}
