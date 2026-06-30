import test from "node:test";
import assert from "node:assert/strict";
import { MAX_MOVES_PER_TUNNEL, shouldRotateTunnel } from "./limits";

test("MAX_MOVES_PER_TUNNEL is the canonical 100k ceiling (binary v2 ~134k capacity)", () => {
  assert.equal(MAX_MOVES_PER_TUNNEL, 100_000);
});

test("shouldRotateTunnel is false below the cap and true at/above it", () => {
  assert.equal(shouldRotateTunnel(0), false);
  assert.equal(shouldRotateTunnel(MAX_MOVES_PER_TUNNEL - 1), false);
  assert.equal(shouldRotateTunnel(MAX_MOVES_PER_TUNNEL), true);
  assert.equal(shouldRotateTunnel(MAX_MOVES_PER_TUNNEL + 1), true);
});
