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

test("verdictOf: unverifiable when no transcript, regardless of result", () => {
  assert.equal(verdictOf(null, false), "unverifiable");
  assert.equal(verdictOf(ok, true), "verified");
  assert.equal(verdictOf({ ...ok, ok: false, allSigsValid: false }, true), "failed");
});
