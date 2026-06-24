import assert from "node:assert/strict";
import { test } from "node:test";
import { concatBytes, toHex } from "./bytes";
import {
  combineReveals,
  computeCommitment,
  DOMAIN_COMMIT_REVEAL,
  verifyCommitment,
} from "./commitment";
import { blake2b256 } from "./crypto";

// Golden vectors shared with sui_tunnel/tests/wire_format_tests.move.
const G_COMMITMENT =
  "9c5d7de7c93e176f232424794b460112bbc1e3edad6af9da200a121e7033f9f9";
const G_SEED =
  "3783060fbc9a59b74485cbd081355de0b78609fb6db3b76d0c97f937dac4b795";

const valueA = Uint8Array.of(7);
const saltA = Uint8Array.from({ length: 16 }, (_, i) => i + 1); // 1..16
const valueB = Uint8Array.of(42);
const saltB = Uint8Array.from({ length: 16 }, (_, i) => i + 17); // 17..32

test("computeCommitment matches Move randomness::create_commitment", () => {
  assert.equal(toHex(computeCommitment(valueA, saltA)), G_COMMITMENT);
});

test("combineReveals matches Move randomness::combine_reveals", () => {
  assert.equal(toHex(combineReveals(valueA, saltA, valueB, saltB)), G_SEED);
});

test("verifyCommitment accepts correct reveal, rejects wrong", () => {
  const c = computeCommitment(valueA, saltA);
  assert.ok(verifyCommitment(c, valueA, saltA));
  assert.ok(!verifyCommitment(c, Uint8Array.of(8), saltA));
  assert.ok(!verifyCommitment(c, valueA, saltB));
});

test("salt shorter than 16 bytes is rejected (matches Move assert)", () => {
  assert.throws(() => computeCommitment(valueA, new Uint8Array(15)));
});

test("verifyCommitment returns false for a short salt instead of throwing (matches Move verify_commitment)", () => {
  const c = computeCommitment(valueA, saltA);
  assert.equal(verifyCommitment(c, valueA, new Uint8Array(15)), false);
});

test("regression: length-prefixed format differs from the old buggy DOMAIN||value||salt", () => {
  const buggy = blake2b256(concatBytes([DOMAIN_COMMIT_REVEAL, valueA, saltA]));
  assert.notEqual(toHex(buggy), G_COMMITMENT);
});
