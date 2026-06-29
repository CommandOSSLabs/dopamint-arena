import { parseBlob } from "./blob";
import { BalanceService, type BalanceClient } from "./rpc";
import { PoolNotFoundError } from "./errors";
import type { CoinType, PoolBlob, WalletEntry } from "./types";
import type { WalletPoolStore } from "./store";

const SUI_TYPE = "0x2::sui::SUI";
const GAS_FLOOR = 50_000_000n;

export type SortKey = "balance" | "ordinal" | "lastUsedAt" | "fundedAmount" | "address";
export type SortDir = "asc" | "desc";

export interface WalletFilter {
  role?: "master" | "member";
  address?: string | { prefix?: string; suffix?: string };
  ordinalGte?: number;
  ordinalLte?: number;
  label?: string;
  enabled?: boolean;
  funded?: boolean;
  holdsCoin?: CoinType;                                        // requires liveBalances
  balanceGte?: { coinType?: CoinType; amount: bigint };        // requires liveBalances
  sufficientForGas?: boolean;                                  // requires liveBalances
  nonzero?: boolean;                                           // requires liveBalances
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

function matchStatic(e: WalletEntry, f: WalletFilter): boolean {
  if (f.role !== undefined && e.role !== f.role) return false;
  if (f.label !== undefined && e.label !== f.label) return false;
  if (f.enabled !== undefined && e.enabled !== f.enabled) return false;
  if (typeof f.address === "string" && e.address !== f.address) return false;
  if (f.address && typeof f.address === "object") {
    if (f.address.prefix && !e.address.startsWith(f.address.prefix)) return false;
    if (f.address.suffix && !e.address.endsWith(f.address.suffix)) return false;
  }
  if (f.ordinalGte !== undefined && e.ordinal < f.ordinalGte) return false;
  if (f.ordinalLte !== undefined && e.ordinal > f.ordinalLte) return false;
  if (f.funded !== undefined) {
    const funded = !!e.fundedAmounts && Object.values(e.fundedAmounts).some((v) => BigInt(v) > 0n);
    if (f.funded !== funded) return false;
  }
  return true;
}

function matchBalance(balances: Map<string, bigint>, f: WalletFilter): boolean {
  if (f.nonzero !== undefined && [...balances.values()].some((b) => b > 0n) !== f.nonzero) return false;
  if (f.holdsCoin !== undefined && !balances.has(f.holdsCoin)) return false;
  if (f.balanceGte && (balances.get(f.balanceGte.coinType ?? SUI_TYPE) ?? 0n) < f.balanceGte.amount) return false;
  if (f.sufficientForGas && (balances.get(SUI_TYPE) ?? 0n) < GAS_FLOOR) return false;
  return true;
}

function sortEntries(entries: ListedWallet[], sort: { key: SortKey; dir?: SortDir }): ListedWallet[] {
  const dir = sort.dir === "desc" ? -1 : 1;
  const bal = (e: ListedWallet) => e.balances?.get(SUI_TYPE) ?? 0n;
  const funded = (e: ListedWallet) => BigInt(e.fundedAmounts?.[SUI_TYPE] ?? "0");
  return [...entries].sort((a, b) => {
    let cmp = 0;
    switch (sort.key) {
      case "ordinal": cmp = a.ordinal - b.ordinal; break;
      case "address": cmp = a.address < b.address ? -1 : a.address > b.address ? 1 : 0; break;
      case "lastUsedAt": cmp = a.lastUsedAt - b.lastUsedAt; break;
      case "balance": cmp = Number(bal(b) - bal(a)); break;
      case "fundedAmount": cmp = Number(funded(b) - funded(a)); break;
    }
    return cmp * dir;
  });
}

export async function list(opts: ListOptions): Promise<ListedWallet[]> {
  const bytes = await opts.store.read(opts.walletPoolId);
  if (!bytes) throw new PoolNotFoundError(opts.walletPoolId);
  const blob = parseBlob(bytes);
  const f = opts.filter ?? {};
  let entries: ListedWallet[] = blob.index.filter((e) => matchStatic(e, f));

  if (opts.liveBalances && opts.client) {
    const svc = new BalanceService(opts.client, 8, opts.balanceTtlMs ?? 5_000);
    const sui = await svc.getBalances(entries.map((e) => e.address), SUI_TYPE);
    entries = entries
      .map((e) => ({ ...e, balances: new Map<string, bigint>([[SUI_TYPE, sui.get(e.address) ?? 0n]]) }))
      .filter((e) => matchBalance(e.balances!, f));
  }

  if (opts.sort) entries = sortEntries(entries, opts.sort);
  const offset = opts.pagination?.offset ?? 0;
  if (offset > 0) entries = entries.slice(offset);
  const limit = opts.pagination?.limit;
  if (limit !== undefined) entries = entries.slice(0, limit);
  return entries;
}

export function pick(entries: ListedWallet[]): ListedWallet | undefined { return entries[0]; }
export function random(entries: ListedWallet[]): ListedWallet | undefined {
  return entries.length ? entries[Math.floor(Math.random() * entries.length)] : undefined;
}
export function lru(entries: ListedWallet[]): ListedWallet | undefined {
  return [...entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
}
export class RoundRobin {
  private cursor = 0;
  next(entries: ListedWallet[]): ListedWallet | undefined {
    if (entries.length === 0) return undefined;
    const e = entries[this.cursor % entries.length];
    this.cursor = (this.cursor + 1) % entries.length;
    return e;
  }
}
