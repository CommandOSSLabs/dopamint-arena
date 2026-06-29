import { test } from "node:test";
import assert from "node:assert/strict";
import { Transaction } from "@mysten/sui/transactions";
import { resolveTargets, buildSuiFundTransaction, fund } from "./fund";
import { create } from "./create";
import { InsufficientFundsError, NetworkMismatchError } from "./errors";
import type { PoolBlob, WalletEntry } from "./types";

function index(): WalletEntry[] {
  return [
    {
      role: "master",
      address: "0xM",
      ordinal: 0,
      createdAt: 0,
      enabled: true,
      useCount: 0,
      lastUsedAt: 0,
    },
    {
      role: "member",
      address: "0xA",
      ordinal: 1,
      createdAt: 0,
      enabled: true,
      useCount: 0,
      lastUsedAt: 0,
    },
    {
      role: "member",
      address: "0xB",
      ordinal: 2,
      createdAt: 0,
      enabled: true,
      useCount: 0,
      lastUsedAt: 0,
    },
    {
      role: "member",
      address: "0xC",
      ordinal: 3,
      createdAt: 0,
      enabled: false,
      useCount: 0,
      lastUsedAt: 0,
    },
  ];
}
const blob = {
  version: 1,
  walletPoolId: "wp_x",
  network: "testnet",
  createdAt: 0,
  coinTypes: [],
  index: index(),
} as unknown as PoolBlob;

function memStore() {
  const data = new Map<string, Uint8Array>();
  return {
    read: async (id: string) => data.get(id) ?? null,
    write: async (id: string, b: Uint8Array) => {
      data.set(id, b);
    },
    list: async () => [...data.keys()],
    delete: async (id: string) => {
      data.delete(id);
    },
  };
}

test("resolveTargets all selects enabled members only", () => {
  const t = resolveTargets(blob, "all", 100n);
  assert.deepEqual(
    t.map((x) => x.address),
    ["0xA", "0xB"],
  );
  assert.ok(t.every((x) => x.amount === 100n));
});

test("resolveTargets subset filters by address", () => {
  const t = resolveTargets(blob, ["0xB", "0xC"], 50n);
  assert.deepEqual(
    t.map((x) => x.address),
    ["0xB"],
  ); // 0xC disabled -> excluded
});

test("buildSuiFundTransaction is constructable", () => {
  const tx = buildSuiFundTransaction([{ address: "0xA", amount: 1n }]);
  assert.ok(tx instanceof Transaction);
});

test("fund throws InsufficientFundsError when master SUI balance is too low", async () => {
  const store = memStore();
  const created = await create({
    network: "testnet",
    members: 2,
    master: { generate: true },
    store,
  });
  const fakeClient = {
    getBalance: async () => ({ totalBalance: "1" }),
    signAndExecuteTransaction: async () => ({ digest: "0x0" }),
    waitForTransaction: async () => {},
  } as unknown as import("@mysten/sui/client").SuiClient;
  await assert.rejects(
    () =>
      fund({
        store,
        walletPoolId: created.walletPoolId,
        accessValue: created.accessValue,
        network: "testnet",
        amount: 1_000_000_000n,
        client: fakeClient,
      }),
    InsufficientFundsError,
  );
});

test("fund throws NetworkMismatchError when network does not match pool", async () => {
  const store = memStore();
  const created = await create({
    network: "testnet",
    members: 1,
    master: { generate: true },
    store,
  });
  await assert.rejects(
    () =>
      fund({
        store,
        walletPoolId: created.walletPoolId,
        accessValue: created.accessValue,
        network: "mainnet",
        amount: 1n,
      }),
    NetworkMismatchError,
  );
});
