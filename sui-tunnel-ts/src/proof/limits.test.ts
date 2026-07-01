import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MOVES_PER_TUNNEL,
  shouldRotateTunnel,
  canSafelyPlayNextEpisode,
} from "./limits";

test("MAX_MOVES_PER_TUNNEL is the canonical 100k ceiling (binary v2 ~134k capacity)", () => {
  assert.equal(MAX_MOVES_PER_TUNNEL, 100_000);
});

test("shouldRotateTunnel is false below the cap and true at/above it", () => {
  assert.equal(shouldRotateTunnel(0), false);
  assert.equal(shouldRotateTunnel(MAX_MOVES_PER_TUNNEL - 1), false);
  assert.equal(shouldRotateTunnel(MAX_MOVES_PER_TUNNEL), true);
  assert.equal(shouldRotateTunnel(MAX_MOVES_PER_TUNNEL + 1), true);
});

test("canSafelyPlayNextEpisode factors in the buffer to prevent mid-game limits", () => {
  assert.equal(canSafelyPlayNextEpisode(0, 1000), true);
  // Exactly hits the limit, meaning it's NOT safe (we want strictly less)
  assert.equal(
    canSafelyPlayNextEpisode(MAX_MOVES_PER_TUNNEL - 1000, 1000),
    false
  );
  // Over the limit
  assert.equal(
    canSafelyPlayNextEpisode(MAX_MOVES_PER_TUNNEL - 500, 1000),
    false
  );
  // Safe by 1 move
  assert.equal(
    canSafelyPlayNextEpisode(MAX_MOVES_PER_TUNNEL - 1001, 1000),
    true
  );
});
