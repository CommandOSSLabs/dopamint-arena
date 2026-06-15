import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveSeed, mulberry32 } from "./rng";

test("deriveSeed is deterministic and well-separated across adjacent indices", () => {
  const s = 12345;
  assert.equal(deriveSeed(s, 5), deriveSeed(s, 5)); // deterministic
  const a = deriveSeed(s, 0);
  const b = deriveSeed(s, 1);
  assert.notEqual(a, b);
  // Derived streams diverge immediately — the old per-worker `seed + i*1000` scheme could
  // hand mulberry32 closely-related states; deriveSeed avalanches the index in.
  assert.notEqual(mulberry32(a)(), mulberry32(b)());
});
