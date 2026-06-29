import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import type { CoinType, Network } from "./types";
import { KeyCache } from "./keycache";

const SUI_TYPE = "0x2::sui::SUI";

/** Narrow balance-read interface. SuiClient satisfies this; fakes welcome in tests. */
export interface BalanceClient {
  getBalance(input: {
    owner: string;
    coinType?: string;
  }): Promise<{ balance: string }>;
}

const clients = new Map<string, SuiClient>();

/** One reused keep-alive client per network/URL pair. */
export function getClient(network: Network, urlOverride?: string): SuiClient {
  const url = urlOverride ?? getFullnodeUrl(network);
  const key = `${network}:${url}`;
  let c = clients.get(key);
  if (!c) {
    c = new SuiClient({ url });
    clients.set(key, c);
  }
  return c;
}

/** Balance reads with TTL cache + bounded parallelism + in-flight dedup. */
export class BalanceService {
  private cache: KeyCache<bigint>;
  private inflight = new Map<string, Promise<bigint>>();

  constructor(
    private client: BalanceClient,
    private concurrency = 8,
    ttlMs = 5_000,
    max = 1024,
  ) {
    this.cache = new KeyCache<bigint>(max, ttlMs);
  }

  private cacheKey(address: string, coinType?: CoinType): string {
    return `${address}:${coinType ?? SUI_TYPE}`;
  }

  async getBalance(address: string, coinType?: CoinType): Promise<bigint> {
    const key = this.cacheKey(address, coinType);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const bal = BigInt(
        (await this.client.getBalance({ owner: address, coinType })).balance,
      );
      this.cache.set(key, bal);
      return bal;
    })();

    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  async getBalances(
    addresses: string[],
    coinType?: CoinType,
  ): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    const unique = [...new Set(addresses)];
    for (let i = 0; i < unique.length; i += this.concurrency) {
      const slice = unique.slice(i, i + this.concurrency);
      const entries = await Promise.all(
        slice.map(
          async (a) => [a, await this.getBalance(a, coinType)] as const,
        ),
      );
      for (const [a, b] of entries) out.set(a, b);
    }
    return out;
  }
}
