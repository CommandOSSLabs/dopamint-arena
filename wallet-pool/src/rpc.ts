import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import type { CoinType, Network } from "./types";
import { KeyCache } from "./keycache";

/** Narrow balance-read interface. SuiClient satisfies this; fakes welcome in tests. */
export interface BalanceClient {
  getBalance(input: { owner: string; coinType?: string }): Promise<{ balance: string }>;
}

const clients = new Map<Network, SuiClient>();

/** One reused keep-alive client per network. */
export function getClient(network: Network, urlOverride?: string): SuiClient {
  let c = clients.get(network);
  if (!c) {
    c = new SuiClient({ url: urlOverride ?? getFullnodeUrl(network) });
    clients.set(network, c);
  }
  return c;
}

/** Balance reads with TTL cache + bounded parallelism. */
export class BalanceService {
  private cache: KeyCache<bigint>;

  constructor(
    private client: BalanceClient,
    private concurrency = 8,
    ttlMs = 5_000,
    max = 1024,
  ) {
    this.cache = new KeyCache<bigint>(max, ttlMs);
  }

  async getBalance(address: string, coinType?: CoinType): Promise<bigint> {
    const key = `${address}:${coinType ?? "*"}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const bal = BigInt((await this.client.getBalance({ owner: address, coinType })).balance);
    this.cache.set(key, bal);
    return bal;
  }

  async getBalances(addresses: string[], coinType?: CoinType): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (let i = 0; i < addresses.length; i += this.concurrency) {
      const slice = addresses.slice(i, i + this.concurrency);
      const entries = await Promise.all(
        slice.map(async (a) => [a, await this.getBalance(a, coinType)] as const),
      );
      for (const [a, b] of entries) out.set(a, b);
    }
    return out;
  }
}
