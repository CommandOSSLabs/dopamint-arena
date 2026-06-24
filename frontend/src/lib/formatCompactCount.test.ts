import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCompactCount } from "./formatCompactCount";

test("formatCompactCount keeps small values literal", () => {
  assert.equal(formatCompactCount(0), "0");
  assert.equal(formatCompactCount(999), "999");
});

test("formatCompactCount abbreviates thousands and above", () => {
  assert.equal(formatCompactCount(1000), "1K");
  assert.equal(formatCompactCount(1500), "1.5K");
  assert.equal(formatCompactCount(1_000_000), "1M");
  assert.equal(formatCompactCount(2_500_000_000), "2.5B");
  assert.equal(formatCompactCount(-1200), "-1.2K");
});
