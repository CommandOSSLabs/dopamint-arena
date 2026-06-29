import { test } from "node:test";
import assert from "node:assert/strict";
import { exportPool, importPool, deletePool, listPools } from "./manage";
import { PoolNotFoundError } from "./errors";
import type { WalletPoolStore } from "./store";
import type { PoolBlob } from "./types";

function memStore(initial: Record<string, Uint8Array> = {}): WalletPoolStore {
  const data = new Map(Object.entries(initial));
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

const blob: PoolBlob = {
  version: 1,
  walletPoolId: "wp_imp",
  network: "testnet",
  createdAt: 0,
  coinTypes: [],
  crypto: { mode: "generated", nonce: "n", tag: "t", ciphertext: "c" },
  index: [],
};
const blobBytes = new TextEncoder().encode(JSON.stringify(blob));

test("export returns raw sealed blob", async () => {
  assert.deepEqual(
    await exportPool({
      store: memStore({ wp_imp: blobBytes }),
      walletPoolId: "wp_imp",
    }),
    blobBytes,
  );
});

test("export missing throws", async () => {
  await assert.rejects(
    () => exportPool({ store: memStore(), walletPoolId: "wp_x" }),
    PoolNotFoundError,
  );
});

test("import + listPools + delete", async () => {
  const store = memStore();
  const { walletPoolId } = await importPool({ store, blob: blobBytes });
  assert.equal(walletPoolId, "wp_imp");
  assert.deepEqual(await listPools({ store }), ["wp_imp"]);
  await deletePool({ store, walletPoolId });
  assert.deepEqual(await listPools({ store }), []);
});
