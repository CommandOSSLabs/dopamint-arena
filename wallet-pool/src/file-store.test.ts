import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWalletPoolStore } from "./file-store";
import { StoreError } from "./errors";

function tmpStore() {
  const base = mkdtempSync(join(tmpdir(), "wp-"));
  return new FileWalletPoolStore(join(base, "inner")); // ensureDir creates it
}

test("write/read/list/delete round-trip", async () => {
  const s = tmpStore();
  const id = "wp_abc123_-";
  await s.write(id, new TextEncoder().encode("{}"));
  assert.deepEqual(await s.read(id), new TextEncoder().encode("{}"));
  assert.deepEqual(await s.list(), [id]);
  await s.delete(id);
  assert.equal(await s.read(id), null);
  assert.deepEqual(await s.list(), []);
});

test("read missing returns null", async () => {
  assert.equal(await tmpStore().read("wp_nope"), null);
});

test("files are owner-only", async () => {
  const s = tmpStore();
  await s.write("wp_x", new TextEncoder().encode("x"));
  const st = statSync(join(s.dir, "wp_x.json"));
  assert.equal(st.mode & 0o077, 0, "no group/other access bits");
});

test("rejects invalid pool id", async () => {
  await assert.rejects(
    () => tmpStore().write("../escape", new Uint8Array()),
    StoreError,
  );
});
