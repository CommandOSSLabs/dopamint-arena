import { parseBlob } from "./blob";
import { BalanceService, type BalanceClient } from "./rpc";
import { PoolNotFoundError, WalletPoolError } from "./errors";
import type { CoinType, PoolBlob, WalletEntry } from "./types";
import type { WalletPoolStore } from "./store";

const SUI_TYPE = "0x2::sui::SUI";
const GAS_FLOOR = 50_000_000n;

export type SortKey =
  "balance" | "ordinal" | "lastUsedAt" | "fundedAmount" | "address";
export type SortDir = "asc" | "desc";

export interface WalletFilter {
  role?: "master" | "member";
  address?: string | { prefix?: string; suffix?: string };
  ordinalGte?: number;
  ordinalLte?: number;
  label?: string;
  enabled?: boolean;
  funded?: boolean;
  /** Requires live balances. True means at least one fetched coin balance is > 0. */
  nonzero?: boolean;
  /** Requires live balances. True means the wallet holds > 0 of this coin type. */
  holdsCoin?: CoinType;
  /** Requires live balances. Defaults to SUI when coinType is omitted. */
  balanceGte?: { coinType?: CoinType; amount: bigint };
  /** Requires live balances. True means SUI balance is at least GAS_FLOOR. */
  sufficientForGas?: boolean;
}

export interface ListOptions {
  store: WalletPoolStore;
  walletPoolId: string;
  filter?: WalletFilter;
  sort?: { key: SortKey; dir?: SortDir };
  pagination?: { limit?: number; offset?: number };
  liveBalances?: boolean;
  client?: BalanceClient;
  balanceTtlMs?: number;
}

export interface ListedWallet extends WalletEntry {
  balances?: Map<string, bigint>;
}

function matchStatic(entry: WalletEntry, filter: WalletFilter): boolean {
  if (filter.role !== undefined && entry.role !== filter.role) return false;
  if (filter.label !== undefined && entry.label !== filter.label) return false;
  if (filter.enabled !== undefined && entry.enabled !== filter.enabled)
    return false;
  if (typeof filter.address === "string" && entry.address !== filter.address)
    return false;
  if (filter.address && typeof filter.address === "object") {
    if (
      filter.address.prefix &&
      !entry.address.startsWith(filter.address.prefix)
    )
      return false;
    if (filter.address.suffix && !entry.address.endsWith(filter.address.suffix))
      return false;
  }
  if (filter.ordinalGte !== undefined && entry.ordinal < filter.ordinalGte)
    return false;
  if (filter.ordinalLte !== undefined && entry.ordinal > filter.ordinalLte)
    return false;
  if (filter.funded !== undefined) {
    const funded =
      !!entry.fundedAmounts &&
      Object.values(entry.fundedAmounts).some((v) => BigInt(v) > 0n);
    if (filter.funded !== funded) return false;
  }
  return true;
}

function matchBalance(
  balances: Map<string, bigint>,
  filter: WalletFilter,
): boolean {
  if (
    filter.nonzero !== undefined &&
    [...balances.values()].some((b) => b > 0n) !== filter.nonzero
  )
    return false;
  if (
    filter.holdsCoin !== undefined &&
    (balances.get(filter.holdsCoin) ?? 0n) <= 0n
  )
    return false;
  if (
    filter.balanceGte &&
    (balances.get(filter.balanceGte.coinType ?? SUI_TYPE) ?? 0n) <
      filter.balanceGte.amount
  )
    return false;
  if (
    filter.sufficientForGas !== undefined &&
    (balances.get(SUI_TYPE) ?? 0n) >= GAS_FLOOR !== filter.sufficientForGas
  )
    return false;
  return true;
}

/** Coin types that must be fetched to evaluate the given filter. */
function requiredCoinTypes(filter: WalletFilter): string[] {
  const set = new Set<string>();
  if (filter.sufficientForGas !== undefined) set.add(SUI_TYPE);
  if (filter.nonzero !== undefined) set.add(SUI_TYPE);
  if (filter.balanceGte && !filter.balanceGte.coinType) set.add(SUI_TYPE);
  if (filter.holdsCoin) set.add(filter.holdsCoin);
  if (filter.balanceGte?.coinType) set.add(filter.balanceGte.coinType);
  return [...set];
}

function needsBalanceFilter(filter: WalletFilter): boolean {
  return (
    filter.nonzero !== undefined ||
    filter.holdsCoin !== undefined ||
    filter.balanceGte !== undefined ||
    filter.sufficientForGas !== undefined
  );
}

function sortEntries(
  entries: ListedWallet[],
  sort: { key: SortKey; dir?: SortDir },
): ListedWallet[] {
  const dir = sort.dir === "desc" ? -1 : 1;
  const suiBalance = (entry: ListedWallet) =>
    entry.balances?.get(SUI_TYPE) ?? 0n;
  const fundedSui = (entry: ListedWallet) =>
    BigInt(entry.fundedAmounts?.[SUI_TYPE] ?? "0");
  return [...entries].sort((a, b) => {
    let cmp = 0;
    switch (sort.key) {
      case "ordinal":
        cmp = a.ordinal - b.ordinal;
        break;
      case "address":
        cmp = a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
        break;
      case "lastUsedAt":
        cmp = a.lastUsedAt - b.lastUsedAt;
        break;
      case "balance":
        cmp =
          suiBalance(a) > suiBalance(b)
            ? 1
            : suiBalance(a) < suiBalance(b)
              ? -1
              : 0;
        break;
      case "fundedAmount":
        cmp =
          fundedSui(a) > fundedSui(b)
            ? 1
            : fundedSui(a) < fundedSui(b)
              ? -1
              : 0;
        break;
    }
    return cmp * dir;
  });
}

/**
 * List wallets from a pool with optional filtering, sorting, and pagination.
 *
 * Balance-related filters require `liveBalances: true` and a `BalanceClient`.
 * When `liveBalances` is enabled, returned entries include a `balances` map
 * keyed by the coin types needed for the filter (or SUI when no filter needs
 * balances).
 */
export async function list(opts: ListOptions): Promise<ListedWallet[]> {
  const bytes = await opts.store.read(opts.walletPoolId);
  if (!bytes) throw new PoolNotFoundError(opts.walletPoolId);
  const blob = parseBlob(bytes);
  const filter = opts.filter ?? {};
  let entries: ListedWallet[] = blob.index.filter((entry) =>
    matchStatic(entry, filter),
  );

  const balanceFilter = needsBalanceFilter(filter);
  if (balanceFilter && (!opts.liveBalances || !opts.client)) {
    throw new WalletPoolError(
      "balance filters require both liveBalances and a client",
    );
  }
  if (opts.liveBalances && !opts.client) {
    throw new WalletPoolError("liveBalances requires a client");
  }

  if ((balanceFilter || opts.liveBalances) && opts.client) {
    const balanceService = new BalanceService(
      opts.client,
      8,
      opts.balanceTtlMs ?? 5_000,
    );
    const coinTypes = requiredCoinTypes(filter);
    if (opts.liveBalances && coinTypes.length === 0) coinTypes.push(SUI_TYPE);

    const balances = new Map<string, Map<string, bigint>>();
    for (const entry of entries) {
      balances.set(entry.address, new Map());
    }

    for (const coinType of coinTypes) {
      const perCoin = await balanceService.getBalances(
        entries.map((entry) => entry.address),
        coinType,
      );
      for (const [address, balance] of perCoin) {
        balances.get(address)?.set(coinType, balance);
      }
    }

    entries = entries.map((entry) => ({
      ...entry,
      balances: balances.get(entry.address),
    }));
    if (balanceFilter) {
      entries = entries.filter((entry) =>
        matchBalance(entry.balances as Map<string, bigint>, filter),
      );
    }
  }

  if (opts.sort) entries = sortEntries(entries, opts.sort);

  const offset = opts.pagination?.offset ?? 0;
  const limit = opts.pagination?.limit;
  if (offset < 0 || (limit !== undefined && limit < 0)) {
    throw new WalletPoolError(
      "pagination offset and limit must be non-negative",
    );
  }
  if (offset > 0) entries = entries.slice(offset);
  if (limit !== undefined) entries = entries.slice(0, limit);
  return entries;
}

/** Return the first entry, or undefined if the list is empty. */
export function pick(entries: ListedWallet[]): ListedWallet | undefined {
  return entries[0];
}

/** Return a uniformly random entry, or undefined if the list is empty. */
export function random(entries: ListedWallet[]): ListedWallet | undefined {
  return entries.length
    ? entries[Math.floor(Math.random() * entries.length)]
    : undefined;
}

/** Return the least-recently-used entry, or undefined if the list is empty. */
export function lru(entries: ListedWallet[]): ListedWallet | undefined {
  return [...entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
}

/**
 * Stateful round-robin selector. The cursor advances on each call.
 * Results are predictable only when the input array has a stable length
 * and order.
 */
export class RoundRobin {
  private cursor = 0;
  next(entries: ListedWallet[]): ListedWallet | undefined {
    if (entries.length === 0) return undefined;
    this.cursor = this.cursor % entries.length;
    const entry = entries[this.cursor];
    this.cursor = (this.cursor + 1) % entries.length;
    return entry;
  }
}
