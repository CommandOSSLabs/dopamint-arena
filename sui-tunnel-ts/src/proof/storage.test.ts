import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryStore, LocalFileStore, WalrusStore } from "./storage";
import { ProofRecord } from "./transcript";

const record: ProofRecord = {
  tunnelId: "0xabc",
  root: "ab".repeat(32),
  updateCount: 2,
  entries: [
    { nonce: "1", message: "00", sigA: "11", sigB: "22" },
    { nonce: "2", message: "01", sigA: "33", sigB: "44" },
  ],
};

test("InMemoryStore round-trips a record", async () => {
  const store = new InMemoryStore();
  const { ref } = await store.put(record);
  const got = await store.get(ref);
  assert.deepEqual(got, record);
  assert.equal(await store.get("missing"), null);
});

test("WalrusStore uses injected publish/read hooks (Walrus optional)", async () => {
  const blobs = new Map<string, Uint8Array>();
  let counter = 0;
  const store = new WalrusStore(
    async (bytes) => {
      const ref = `blob:${counter++}`;
      blobs.set(ref, bytes);
      return { ref };
    },
    async (ref) => blobs.get(ref) ?? null
  );
  const { ref } = await store.put(record);
  assert.ok(ref.startsWith("blob:"));
  const got = await store.get(ref);
  assert.deepEqual(got, record);
});

test("WalrusStore.get returns null when no reader is provided", async () => {
  const store = new WalrusStore(async () => ({ ref: "blob:x" }));
  await store.put(record);
  assert.equal(await store.get("blob:x"), null);
});

test("LocalFileStore writes and reads a JSON file", async () => {
  const dir = `/tmp/sui-tunnel-proof-test-${process.pid}`;
  const store = new LocalFileStore(dir);
  const { ref } = await store.put(record);
  assert.ok(ref.includes("0xabc"));
  const got = await store.get(ref);
  assert.deepEqual(got, record);
  assert.equal(await store.get(`${dir}/nonexistent.json`), null);
  const fs = await import("node:fs/promises");
  await fs.rm(dir, { recursive: true, force: true });
});
