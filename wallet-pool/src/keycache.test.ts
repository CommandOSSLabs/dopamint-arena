import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyCache } from "./keycache";

test("hit and miss", () => {
  const c = new KeyCache<string>(2, 10_000);
  c.set("a", "1");
  assert.equal(c.get("a"), "1");
  assert.equal(c.get("b"), undefined);
});

test("ttl expiry evicts stale", async () => {
  const c = new KeyCache<string>(2, 5);
  c.set("a", "1");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.get("a"), undefined);
});

test("lru eviction drops least-recent", () => {
  const c = new KeyCache<string>(2, 10_000);
  c.set("a", "1");
  c.set("b", "2");
  c.get("a"); // a most-recent
  c.set("c", "3"); // evicts b
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), "1");
  assert.equal(c.get("c"), "3");
});

test("delete and clear", () => {
  const c = new KeyCache<string>(2, 10_000);
  c.set("a", "1");
  c.delete("a");
  assert.equal(c.size, 0);
  c.set("a", "1");
  c.clear();
  assert.equal(c.size, 0);
});
