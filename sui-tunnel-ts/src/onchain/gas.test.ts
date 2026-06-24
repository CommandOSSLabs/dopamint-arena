import assert from "node:assert/strict";
import { test } from "node:test";
import { planGasShards, SignerPool } from "./gas";

test("planGasShards splits a budget into amounts summing to the total", () => {
  const shards = planGasShards(1000n, 7);
  assert.equal(shards.length, 7);
  assert.equal(
    shards.reduce((a, b) => a + b, 0n),
    1000n
  );
  // near-equal: max - min <= 1
  const max = shards.reduce((a, b) => (a > b ? a : b));
  const min = shards.reduce((a, b) => (a < b ? a : b));
  assert.ok(max - min <= 1n);
});

test("planGasShards rejects non-positive count", () => {
  assert.throws(() => planGasShards(100n, 0));
});

test("SignerPool round-robins and exposes distinct addresses", () => {
  const pool = SignerPool.generate(4);
  assert.equal(pool.size, 4);
  const addrs = pool.addresses();
  assert.equal(new Set(addrs).size, 4);
  // round-robin returns each signer once per cycle
  const seen = [
    pool.next(),
    pool.next(),
    pool.next(),
    pool.next(),
    pool.next(),
  ];
  assert.equal(seen[0], seen[4]); // wrapped around
  assert.equal(pool.at(5), pool.at(1));
});
