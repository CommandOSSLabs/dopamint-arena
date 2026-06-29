import { test } from "node:test";
import assert from "node:assert/strict";
import { viewBalance } from "./balance";
import {
  NetworkMismatchError,
  PoolNotFoundError,
  WalletPoolError,
} from "./errors";
import type { BalanceClient } from "./rpc";
import type { WalletPoolStore } from "./store";
import type { PoolBlob, WalletEntry } from "./types";

const SUI_TYPE = "0x2::sui::SUI";

function entry(address: string, ordinal: number): WalletEntry {
  return {
    role: "member",
    address,
    ordinal,
    createdAt: 0,
    enabled: true,
    useCount: 0,
    lastUsedAt: 0,
  };
}

function storeWith(index: WalletEntry[], id = "wp_x"): WalletPoolStore {
  const blob: PoolBlob = {
    version: 1,
    walletPoolId: id,
    network: "testnet",
    createdAt: 0,
    coinTypes: [],
    crypto: { mode: "generated", nonce: "n", tag: "t", ciphertext: "c" },
    index,
  };
  const data = new Map([[id, new TextEncoder().encode(JSON.stringify(blob))]]);
  return {
    read: async (x: string) => data.get(x) ?? null,
    write: async () => {},
    list: async () => [...data.keys()],
    delete: async () => {},
  };
}

const fakeClient: BalanceClient = {
  getBalance: async ({ owner, coinType }) => ({
    balance:
      coinType && coinType !== SUI_TYPE
        ? "100"
        : owner.endsWith("A")
          ? "7"
          : "3",
  }),
};

test("viewBalance returns all member balances for SUI by default", async () => {
  const m = await viewBalance({
    store: storeWith([entry("0xA", 1), entry("0xB", 2)]),
    walletPoolId: "wp_x",
    network: "testnet",
    client: fakeClient,
  });
  assert.equal(m.size, 2);
  assert.equal(m.get("0xA"), 7n);
  assert.equal(m.get("0xB"), 3n);
});

test("viewBalance filters by ordinal", async () => {
  const m = await viewBalance({
    store: storeWith([entry("0xA", 1), entry("0xB", 2)]),
    walletPoolId: "wp_x",
    network: "testnet",
    by: 2,
    client: fakeClient,
  });
  assert.equal(m.size, 1);
  assert.equal(m.get("0xB"), 3n);
});

test("viewBalance filters by address", async () => {
  const m = await viewBalance({
    store: storeWith([entry("0xA", 1), entry("0xB", 2)]),
    walletPoolId: "wp_x",
    network: "testnet",
    by: "0xA",
    client: fakeClient,
  });
  assert.equal(m.size, 1);
  assert.equal(m.get("0xA"), 7n);
});

test("viewBalance throws when ordinal is not in the pool", async () => {
  await assert.rejects(
    () =>
      viewBalance({
        store: storeWith([entry("0xA", 1)]),
        walletPoolId: "wp_x",
        network: "testnet",
        by: 99,
        client: fakeClient,
      }),
    (err) =>
      err instanceof WalletPoolError &&
      /ordinal not found: 99/.test(err.message),
  );
});

test("viewBalance throws PoolNotFoundError for missing pool", async () => {
  await assert.rejects(
    () =>
      viewBalance({
        store: storeWith([], "wp_x"),
        walletPoolId: "wp_missing",
        network: "testnet",
        client: fakeClient,
      }),
    PoolNotFoundError,
  );
});

test("viewBalance uses custom coinType", async () => {
  const m = await viewBalance({
    store: storeWith([entry("0xA", 1)]),
    walletPoolId: "wp_x",
    network: "testnet",
    coinType: "0x123::fake::FAKE",
    client: fakeClient,
  });
  assert.equal(m.size, 1);
  assert.equal(m.get("0xA"), 100n);
});

test("viewBalance throws NetworkMismatchError when networks differ", async () => {
  await assert.rejects(
    () =>
      viewBalance({
        store: storeWith([entry("0xA", 1)]),
        walletPoolId: "wp_x",
        network: "mainnet",
        client: fakeClient,
      }),
    NetworkMismatchError,
  );
});
