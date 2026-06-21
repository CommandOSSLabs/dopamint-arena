import { test } from "node:test";
import assert from "node:assert/strict";
import { checksOf, verdictOf } from "./verifyModel";
import type { TranscriptVerification } from "../../../sui-tunnel-ts/src/proof/transcript";

const ok: TranscriptVerification = {
  ok: true, rootMatches: true, allSigsValid: true, nonceMonotonic: true,
  balancesConserved: true, stepCount: 2, steps: [], failures: [],
};

test("checksOf maps the four properties in order", () => {
  const c = checksOf(ok);
  assert.deepEqual(c.map((x) => x.key), ["sigs", "nonce", "conserve", "root"]);
  assert.ok(c.every((x) => x.ok));
});

test("verdictOf: verified only with transcript + anchored root + signed steps", () => {
  assert.equal(verdictOf(ok, true, true), "verified");
  assert.equal(verdictOf({ ...ok, ok: false, allSigsValid: false }, true, true), "failed");
});

test("verdictOf: unverifiable when no transcript, regardless of result", () => {
  assert.equal(verdictOf(null, false, true), "unverifiable");
  assert.equal(verdictOf(ok, false, true), "unverifiable");
});

test("verdictOf: a transcript with no on-chain anchored root is unverifiable, not failed", () => {
  // Regression: a close without an anchored root (transcriptRoot null) used to render a scary red
  // "FAILED" because rootMatches was false against an empty root. It is not failed — it's uncheckable.
  assert.equal(verdictOf(ok, true, false), "unverifiable");
  assert.equal(verdictOf({ ...ok, ok: false, rootMatches: false }, true, false), "unverifiable");
});

test("verdictOf: zero signed steps is never a green seal", () => {
  // Edge: an all-zero anchored root + empty transcript trivially "matches" with every flag true.
  // That proves no interaction, so it must not read as verified.
  assert.equal(verdictOf({ ...ok, stepCount: 0 }, true, true), "unverifiable");
});
