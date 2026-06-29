import { parseBlob } from "./blob";
import { BalanceService, getClient, type BalanceClient } from "./rpc";
import { PoolNotFoundError } from "./errors";
import type { CoinType, Network } from "./types";
import type { WalletPoolStore } from "./store";

const SUI_TYPE = "0x2::sui::SUI";

export interface ViewBalanceOptions {
  store: WalletPoolStore;
  walletPoolId: string;
  network: Network;
  by?: string | number | "all";
  coinType?: CoinType;
  client?: BalanceClient;
  balanceTtlMs?: number;
}

export async function viewBalance(
  opts: ViewBalanceOptions,
): Promise<Map<string, bigint>> {
  const bytes = await opts.store.read(opts.walletPoolId);
  if (!bytes) throw new PoolNotFoundError(opts.walletPoolId);
  const blob = parseBlob(bytes);
  const coinType = opts.coinType ?? SUI_TYPE;
  const by = opts.by ?? "all";
  const addrs =
    by === "all"
      ? blob.index.map((e) => e.address)
      : [
          typeof by === "number"
            ? (blob.index.find((e) => e.ordinal === by)?.address ?? "")
            : by,
        ].filter((a) => a !== "");
  const client =
    opts.client ?? (getClient(blob.network) as unknown as BalanceClient);
  return new BalanceService(client, 8, opts.balanceTtlMs ?? 5_000).getBalances(
    addrs,
    coinType,
  );
}
