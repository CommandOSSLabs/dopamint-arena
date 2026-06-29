import { parseBlob } from "./blob";
import { BalanceService, getClient, type BalanceClient } from "./rpc";
import {
  NetworkMismatchError,
  PoolNotFoundError,
  WalletPoolError,
} from "./errors";
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
  concurrency?: number;
}

/**
 * Read balances for pool members.
 *
 * - `by` defaults to `"all"`; it can also be a member ordinal or an address
 *   that exists in the pool.
 * - `coinType` defaults to SUI.
 * - If `client` is omitted, a client is created for the pool's stored network.
 * - `balanceTtlMs` defaults to 5000ms.
 * - `concurrency` defaults to 8.
 *
 * @throws PoolNotFoundError if the pool does not exist.
 * @throws NetworkMismatchError if `opts.network` differs from the stored pool network.
 * @throws WalletPoolError if the requested ordinal or address is not in the pool.
 */
export async function viewBalance(
  opts: ViewBalanceOptions,
): Promise<Map<string, bigint>> {
  const bytes = await opts.store.read(opts.walletPoolId);
  if (!bytes) throw new PoolNotFoundError(opts.walletPoolId);
  const blob = parseBlob(bytes);

  if (opts.network !== blob.network) {
    throw new NetworkMismatchError(
      `operation network ${opts.network} does not match pool network ${blob.network}`,
    );
  }

  const coinType = opts.coinType ?? SUI_TYPE;
  const by = opts.by ?? "all";
  let addrs: string[];

  if (by === "all") {
    addrs = blob.index.map((e) => e.address);
  } else if (typeof by === "number") {
    const entry = blob.index.find((e) => e.ordinal === by);
    if (!entry) throw new WalletPoolError(`ordinal not found: ${by}`);
    addrs = [entry.address];
  } else {
    const entry = blob.index.find((e) => e.address === by);
    if (!entry) throw new WalletPoolError(`address not in pool: ${by}`);
    addrs = [entry.address];
  }

  const client: BalanceClient =
    opts.client ?? (getClient(blob.network) as BalanceClient);
  return new BalanceService(
    client,
    opts.concurrency ?? 8,
    opts.balanceTtlMs ?? 5_000,
  ).getBalances(addrs, coinType);
}
