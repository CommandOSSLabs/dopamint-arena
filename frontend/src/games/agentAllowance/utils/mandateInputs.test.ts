import { test } from "node:test";
import assert from "node:assert/strict";

import { parseWholeMtps, validateMandateInputs } from "./mandateInputs.ts";

test("parseWholeMtps accepts whole tokens only", () => {
  assert.equal(parseWholeMtps("100"), 100n);
  assert.equal(parseWholeMtps("  7  "), 7n);
  assert.equal(parseWholeMtps("0.5"), null);
  assert.equal(parseWholeMtps("1.0"), null);
  assert.equal(parseWholeMtps(""), null);
  assert.equal(parseWholeMtps("10a"), null);
});

test("validateMandateInputs enforces whole MTPS and rate <= budget", () => {
  assert.equal(validateMandateInputs("100", "5"), null);
  assert.equal(validateMandateInputs("10", "10"), null);

  assert.match(validateMandateInputs("0.5", "1") ?? "", /whole number/);
  assert.match(validateMandateInputs("10", "0.1") ?? "", /whole number/);
  assert.equal(
    validateMandateInputs("10", "11"),
    "Per-second rate cannot exceed the budget",
  );
  assert.equal(
    validateMandateInputs("10", "0"),
    "Per-second rate must be at least 1",
  );
  assert.equal(
    validateMandateInputs("0", "1"),
    "Budget must be greater than 0",
  );
});
