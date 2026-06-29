import { test } from "node:test";
import assert from "node:assert/strict";
import {
  list,
  pick,
  lru,
  random,
  RoundRobin,
  type ListedWallet,
} from "./listing";
import type { BalanceClient } from "./rpc";
import type { WalletPoolStore } from "./store";
import type { PoolBlob, WalletEntry } from "./types";

function storeWith(index: WalletEntry[], id = "wp_x"): WalletPoolStore {
  const blob = {
    version: 1,
    walletPoolId: id,
    network: "testnet",
    createdAt: 0,
    coinTypes: [],
    crypto: { mode: "generated", nonce: "n", tag: "t", ciphertext: "c" },
    index,
  } as unknown as PoolBlob;
  const data = new Map<string, Uint8Array>([
    [id, new TextEncoder().encode(JSON.stringify(blob))],
  ]);
  return {
    read: async (x: string) => data.get(x) ?? null,
    write: async (x: string, b: Uint8Array) => {
      data.set(x, b);
    },
    list: async () => [...data.keys()],
    delete: async (x: string) => {
      data.delete(x);
    },
  };
}

function entry(
  overrides: Partial<WalletEntry> & { address: string },
): WalletEntry {
  return {
    role: "member",
    ordinal: 0,
    createdAt: 0,
    enabled: true,
    useCount: 0,
    lastUsedAt: 0,
    ...overrides,
  };
}

const members: WalletEntry[] = [
  entry({ role: "master", address: "0xM", ordinal: 0 }),
  entry({ address: "0xA", ordinal: 1, lastUsedAt: 10 }),
  entry({ address: "0xB", ordinal: 2, enabled: false }),
  entry({ address: "0xC", ordinal: 3, lastUsedAt: 5 }),
];

test("filter role + enabled", async () => {
  const r = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { role: "member", enabled: true },
  });
  assert.deepEqual(
    r.map((e) => e.address),
    ["0xA", "0xC"],
  );
});

test("filter address exact", async () => {
  const r = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { address: "0xA" },
  });
  assert.deepEqual(
    r.map((e) => e.address),
    ["0xA"],
  );
});

test("filter address prefix and suffix", async () => {
  const r = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { address: { prefix: "0x", suffix: "C" } },
  });
  assert.deepEqual(
    r.map((e) => e.address),
    ["0xC"],
  );
});

test("filter ordinal range", async () => {
  const r = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { ordinalGte: 1, ordinalLte: 2 },
  });
  assert.deepEqual(
    r.map((e) => e.address),
    ["0xA", "0xB"],
  );
});

test("filter label", async () => {
  const r = await list({
    store: storeWith([
      entry({ address: "0xA", label: "vip" }),
      entry({ address: "0xB", label: "standard" }),
    ]),
    walletPoolId: "wp_x",
    filter: { label: "vip" },
  });
  assert.deepEqual(
    r.map((e) => e.address),
    ["0xA"],
  );
});

test("filter funded", async () => {
  const r = await list({
    store: storeWith([
      entry({ address: "0xA", fundedAmounts: { ["0x2::sui::SUI"]: "1000" } }),
      entry({ address: "0xB" }),
    ]),
    walletPoolId: "wp_x",
    filter: { funded: true },
  });
  assert.deepEqual(
    r.map((e) => e.address),
    ["0xA"],
  );
});

test("sort ordinal desc + pagination", async () => {
  const r = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { role: "member" },
    sort: { key: "ordinal", dir: "desc" },
    pagination: { limit: 1, offset: 1 },
  });
  assert.deepEqual(
    r.map((e) => e.address),
    ["0xB"],
  );
});

test("pagination edge cases", async () => {
  const r = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { role: "member" },
    pagination: { offset: 100, limit: 0 },
  });
  assert.deepEqual(r, []);
  await assert.rejects(
    () =>
      list({
        store: storeWith(members),
        walletPoolId: "wp_x",
        pagination: { offset: -1 },
      }),
    /pagination offset and limit must be non-negative/,
  );
});

test("liveBalances nonzero filter", async () => {
  const fake: BalanceClient = {
    getBalance: async ({ owner }) => ({
      balance: owner === "0xA" ? "1000" : "0",
    }),
  };
  const r = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { role: "member", nonzero: true },
    liveBalances: true,
    client: fake,
  });
  assert.deepEqual(
    r.map((e) => e.address),
    ["0xA"],
  );
});

test("holdsCoin filter fetches the requested coin type", async () => {
  const custom = "0x123::coin::COIN";
  const calls: { owner: string; coinType?: string }[] = [];
  const fake: BalanceClient = {
    getBalance: async ({ owner, coinType }) => {
      calls.push({ owner, coinType });
      return {
        balance: owner === "0xA" && coinType === custom ? "1" : "0",
      };
    },
  };
  const r = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { role: "member", holdsCoin: custom },
    liveBalances: true,
    client: fake,
  });
  assert.deepEqual(
    r.map((e) => e.address),
    ["0xA"],
  );
  assert.ok(
    calls.every((c) => c.coinType === custom),
    "holdsCoin should not fetch SUI",
  );
});

test("balanceGte default SUI", async () => {
  const fake: BalanceClient = {
    getBalance: async ({ owner }) => ({
      balance: owner === "0xA" ? "1000" : owner === "0xC" ? "500" : "0",
    }),
  };
  const r = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { role: "member", balanceGte: { amount: 500n } },
    liveBalances: true,
    client: fake,
  });
  assert.deepEqual(
    r.map((e) => e.address),
    ["0xA", "0xC"],
  );
});

test("balanceGte custom coin type", async () => {
  const custom = "0x123::coin::COIN";
  const fake: BalanceClient = {
    getBalance: async ({ owner, coinType }) => ({
      balance:
        coinType === custom && (owner === "0xA" || owner === "0xC")
          ? owner === "0xA"
            ? "10"
            : "5"
          : "0",
    }),
  };
  const r = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { role: "member", balanceGte: { coinType: custom, amount: 6n } },
    liveBalances: true,
    client: fake,
  });
  assert.deepEqual(
    r.map((e) => e.address),
    ["0xA"],
  );
});

test("sufficientForGas filter", async () => {
  const fake: BalanceClient = {
    getBalance: async ({ owner }) => ({
      balance:
        owner === "0xA" ? "100000000" : owner === "0xC" ? "1000000" : "0",
    }),
  };
  const r = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { role: "member", sufficientForGas: true },
    liveBalances: true,
    client: fake,
  });
  assert.deepEqual(
    r.map((e) => e.address),
    ["0xA"],
  );
  const low = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { role: "member", sufficientForGas: false },
    liveBalances: true,
    client: fake,
  });
  assert.deepEqual(
    low.map((e) => e.address),
    ["0xB", "0xC"],
  );
});

test("liveBalances returns balances without a balance filter", async () => {
  const fake: BalanceClient = {
    getBalance: async ({ owner }) => ({
      balance: owner === "0xA" ? "123" : "0",
    }),
  };
  const r = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { role: "member" },
    liveBalances: true,
    client: fake,
  });
  assert.equal(
    r.find((e) => e.address === "0xA")?.balances?.get("0x2::sui::SUI"),
    123n,
  );
  assert.equal(
    r.find((e) => e.address === "0xC")?.balances?.get("0x2::sui::SUI"),
    0n,
  );
});

test("balance filters require liveBalances and client", async () => {
  await assert.rejects(
    () =>
      list({
        store: storeWith(members),
        walletPoolId: "wp_x",
        filter: { role: "member", nonzero: true },
      }),
    /balance filters require both liveBalances and a client/,
  );
  await assert.rejects(
    () =>
      list({
        store: storeWith(members),
        walletPoolId: "wp_x",
        filter: { role: "member", nonzero: true },
        liveBalances: true,
      }),
    /balance filters require both liveBalances and a client/,
  );
});

test("liveBalances without client throws", async () => {
  await assert.rejects(
    () =>
      list({
        store: storeWith(members),
        walletPoolId: "wp_x",
        liveBalances: true,
      }),
    /liveBalances requires a client/,
  );
});

test("sort by balance ascending", async () => {
  const fake: BalanceClient = {
    getBalance: async ({ owner }) => ({
      balance: owner === "0xA" ? "300" : owner === "0xC" ? "100" : "0",
    }),
  };
  const r = await list({
    store: storeWith(members),
    walletPoolId: "wp_x",
    filter: { role: "member", enabled: true },
    sort: { key: "balance" },
    liveBalances: true,
    client: fake,
  });
  assert.deepEqual(
    r.map((e) => e.address),
    ["0xC", "0xA"],
  );
});

test("pick returns first entry or undefined", () => {
  const xs = [
    entry({ address: "0xA", lastUsedAt: 10 }),
    entry({ address: "0xC", lastUsedAt: 5 }),
  ] as unknown as ListedWallet[];
  assert.equal(pick(xs)?.address, "0xA");
  assert.equal(pick([]), undefined);
});

test("lru returns least-recently-used or undefined", () => {
  const xs = [
    entry({ address: "0xA", lastUsedAt: 10 }),
    entry({ address: "0xC", lastUsedAt: 5 }),
  ] as unknown as ListedWallet[];
  assert.equal(lru(xs)?.address, "0xC");
  assert.equal(lru([]), undefined);
});

test("random returns an entry from the list or undefined", () => {
  const xs = [
    entry({ address: "0xA" }),
    entry({ address: "0xC" }),
  ] as unknown as ListedWallet[];
  assert.ok(["0xA", "0xC"].includes(random(xs)?.address as string));
  assert.equal(random([]), undefined);
});

test("RoundRobin cycles through entries and handles empty arrays", () => {
  const xs = [
    entry({ address: "0xA" }),
    entry({ address: "0xC" }),
  ] as unknown as ListedWallet[];
  const rr = new RoundRobin();
  assert.equal(rr.next(xs)?.address, "0xA");
  assert.equal(rr.next(xs)?.address, "0xC");
  assert.equal(rr.next(xs)?.address, "0xA");
  assert.equal(rr.next([]), undefined);
});
