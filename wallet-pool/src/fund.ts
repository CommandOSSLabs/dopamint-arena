import { Transaction } from "@mysten/sui/transactions";
import type { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { loadPool } from "./pool";
import { fromB64 } from "./crypto";
import { getClient } from "./rpc";
import { InsufficientFundsError } from "./errors";
import type { CoinType, Network, PoolBlob } from "./types";
import type { WalletPoolStore } from "./store";

const SUI_TYPE = "0x2::sui::SUI";
const GAS_BUDGET = 50_000_000n; // 0.05 SUI headroom

export interface FundTarget { address: string; amount: bigint; }

export function resolveTargets(blob: PoolBlob, to: "all" | string[], amount: bigint): FundTarget[] {
  const enabled = blob.index.filter((e) => e.role === "member" && e.enabled);
  const selected = to === "all" ? enabled : enabled.filter((m) => to.includes(m.address));
  return selected.map((m) => ({ address: m.address, amount }));
}

export function buildSuiFundTransaction(targets: FundTarget[]): Transaction {
  const tx = new Transaction();
  if (targets.length === 0) return tx;
  const coins = tx.splitCoins(tx.gas, targets.map((t) => tx.pure.u64(t.amount)));
  targets.forEach((t, i) => tx.transferObjects([coins[i]], tx.pure.address(t.address)));
  return tx;
}

export interface FundOptions {
  store: WalletPoolStore;
  walletPoolId: string;
  accessValue: string;
  network: Network;
  coinType?: CoinType;
  amount: bigint; // per-account base units (MIST)
  to?: "all" | string[];
  rpcUrl?: string;
  client?: SuiClient;
  awaitEffects?: boolean;
}

export async function fund(opts: FundOptions): Promise<{ digest: string }> {
  const coinType = opts.coinType ?? SUI_TYPE;
  const { blob, members } = await loadPool(opts.store, opts.walletPoolId, opts.accessValue);
  const master = Ed25519Keypair.fromSecretKey(fromB64(members.masterSecret));
  const masterAddr = blob.index.find((e) => e.role === "master")!.address;
  const targets = resolveTargets(blob, opts.to ?? "all", opts.amount);
  if (targets.length === 0) throw new Error("no enabled member targets to fund");
  const client = opts.client ?? getClient(blob.network, opts.rpcUrl);
  const total = targets.reduce((s, t) => s + t.amount, 0n);

  const tx = new Transaction();
  if (coinType === SUI_TYPE) {
    const bal = BigInt((await client.getBalance({ owner: masterAddr, coinType: SUI_TYPE })).totalBalance);
    if (bal < total + GAS_BUDGET) throw new InsufficientFundsError(`master SUI ${bal} < ${total + GAS_BUDGET}`);
    const coins = tx.splitCoins(tx.gas, targets.map((t) => tx.pure.u64(t.amount)));
    targets.forEach((t, i) => tx.transferObjects([coins[i]], tx.pure.address(t.address)));
  } else {
    const coinObjectId = await pickCoinObjectId(client, masterAddr, coinType, total);
    const coins = tx.splitCoins(tx.object(coinObjectId), targets.map((t) => tx.pure.u64(t.amount)));
    targets.forEach((t, i) => tx.transferObjects([coins[i]], tx.pure.address(t.address)));
  }
  tx.setGasBudget(Number(GAS_BUDGET));

  const res = await client.signAndExecuteTransaction({ signer: master, transaction: tx, options: { showEffects: true } });
  if (opts.awaitEffects) await client.waitForTransaction({ digest: res.digest });
  return { digest: res.digest };
}

async function pickCoinObjectId(client: SuiClient, owner: string, coinType: string, minBalance: bigint): Promise<string> {
  const { data } = await client.getCoins({ owner, coinType });
  const big = data.find((c) => BigInt(c.balance) >= minBalance);
  if (big) return big.coinObjectId;
  throw new InsufficientFundsError(
    data.length === 0 ? `no ${coinType} coins for ${owner}` : `no single ${coinType} coin >= ${minBalance}; merge coins first (v1 limitation)`,
  );
}
