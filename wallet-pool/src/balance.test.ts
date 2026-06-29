import { test } from "node:test";
import assert from "node:assert/strict";
import { viewBalance } from "./balance";
import type { BalanceClient } from "./rpc";
import type { WalletPoolStore } from "./store";
import type { PoolBlob } from "./types";

function storeWith(index: { address: string }[], id = "wp_x"): WalletPoolStore {
  const blob = {
    version: 1,
    walletPoolId: id,
    network: "testnet",
    createdAt: 0,
    coinTypes: [],
    crypto: { mode: "generated", nonce: "n", tag: "t", ciphertext: "c" },
    index,
  } as unknown as PoolBlob;
  const data = new Map([[id, new TextEncoder().encode(JSON.stringify(blob))]]);
  return {
    read: async (x: string) => data.get(x) ?? null,
    write: async () => {},
    list: async () => [...data.keys()],
    delete: async () => {},
  } as WalletPoolStore;
}

test("viewBalance all (fake client)", async () => {
  const fake: BalanceClient = {
    getBalance: async ({ owner }) => ({
      balance: owner.endsWith("A") ? "7" : "3",
    }),
  };
  const m = await viewBalance({
    store: storeWith([{ address: "0xA" }, { address: "0xB" }]),
    walletPoolId: "wp_x",
    network: "testnet",
    client: fake,
  });
  assert.equal(m.get("0xA"), 7n);
  assert.equal(m.get("0xB"), 3n);
});
