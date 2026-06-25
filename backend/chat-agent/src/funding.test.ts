import { test } from "node:test";
import assert from "node:assert/strict";
import { stakeToRaw } from "./funding.ts";

test("stakeToRaw converts whole tokens", () => {
  assert.equal(stakeToRaw(1n), 1_000_000_000n);
  assert.equal(stakeToRaw(2n), 2_000_000_000n);
});
