import { test } from "node:test";
import assert from "node:assert/strict";
import { list, pick, lru, RoundRobin, type ListedWallet } from "./listing";
import type { BalanceClient } from "./rpc";
import type { WalletPoolStore } from "./store";
import type { PoolBlob, WalletEntry } from "./types";

function storeWith(index: WalletEntry[], id = "wp_x"): WalletPoolStore {
  const blob = {
    version: 1, walletPoolId: id, network: "testnet", createdAt: 0, coinTypes: [],
    crypto: { mode: "generated", nonce: "n", tag: "t", ciphertext: "c" }, index,
  } as unknown as PoolBlob;
  const data = new Map<string, Uint8Array>([[id, new TextEncoder().encode(JSON.stringify(blob))]]);
  return {
    read: async (x: string) => data.get(x) ?? null,
    write: async (x: string, b: Uint8Array) => { data.set(x, b); },
    list: async () => [...data.keys()],
    delete: async (x: string) => { data.delete(x); },
  };
}

const members: WalletEntry[] = [
  { role: "master", address: "0xM", ordinal: 0, createdAt: 0, enabled: true, useCount: 0, lastUsedAt: 0 },
  { role: "member", address: "0xA", ordinal: 1, createdAt: 0, enabled: true, useCount: 0, lastUsedAt: 10 },
  { role: "member", address: "0xB", ordinal: 2, createdAt: 0, enabled: false, useCount: 0, lastUsedAt: 0 },
  { role: "member", address: "0xC", ordinal: 3, createdAt: 0, enabled: true, useCount: 0, lastUsedAt: 5 },
];

test("filter role + enabled", async () => {
  const r = await list({ store: storeWith(members), walletPoolId: "wp_x", filter: { role: "member", enabled: true } });
  assert.deepEqual(r.map((e) => e.address), ["0xA", "0xC"]);
});

test("sort ordinal desc + pagination", async () => {
  const r = await list({
    store: storeWith(members), walletPoolId: "wp_x", filter: { role: "member" },
    sort: { key: "ordinal", dir: "desc" }, pagination: { limit: 1, offset: 1 },
  });
  assert.deepEqual(r.map((e) => e.address), ["0xB"]);
});

test("liveBalances nonzero filter", async () => {
  const fake: BalanceClient = { getBalance: async ({ owner }) => ({ balance: owner === "0xA" ? "1000" : "0" }) };
  const r = await list({
    store: storeWith(members), walletPoolId: "wp_x",
    filter: { role: "member", nonzero: true }, liveBalances: true, client: fake,
  });
  assert.deepEqual(r.map((e) => e.address), ["0xA"]);
});

test("selection helpers + round-robin", () => {
  const xs = [{ address: "0xA", lastUsedAt: 10 }, { address: "0xC", lastUsedAt: 5 }] as unknown as ListedWallet[];
  assert.equal(pick(xs)?.address, "0xA");
  assert.equal(lru(xs)?.address, "0xC");
  const rr = new RoundRobin();
  assert.equal(rr.next(xs)?.address, "0xA");
  assert.equal(rr.next(xs)?.address, "0xC");
  assert.equal(rr.next(xs)?.address, "0xA");
});
