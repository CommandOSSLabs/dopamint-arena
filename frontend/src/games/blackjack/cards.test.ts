import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handValue,
  rankIndexValue,
  valueToCardIndex,
  handToCardIndices,
} from "./cards.ts";

test("handValue sums with soft-ace reduction", () => {
  assert.equal(handValue([11, 10]), 21); // blackjack
  assert.equal(handValue([11, 11]), 12); // one ace reduced 11->1
  assert.equal(handValue([11, 5, 10]), 16); // ace reduced once
  assert.equal(handValue([5, 6]), 11);
  assert.equal(handValue([11, 11, 11]), 13); // multi-ace cascade: two reduced 11->1
});

test("valueToCardIndex yields a 0..51 index whose rank value matches", () => {
  for (let seq = 0; seq < 8; seq++) {
    for (const value of [11, 10, 9, 2]) {
      const idx = valueToCardIndex(value, seq);
      assert.ok(idx >= 0 && idx < 52, `index ${idx} in range`);
      const rankIdx = idx % 13;
      assert.equal(
        rankIndexValue(rankIdx),
        value,
        `rank value matches for ${value}`,
      );
    }
  }
});

test("value 11 is always an Ace; value 10 varies across 10/J/Q/K", () => {
  assert.equal(valueToCardIndex(11, 3) % 13, 0); // Ace rank index
  const faces = new Set([0, 1, 2, 3].map((s) => valueToCardIndex(10, s) % 13));
  assert.ok(faces.size > 1, "ten-valued cards vary by seq");
  for (const r of faces)
    assert.ok(r >= 9 && r <= 12, "ten-valued rank is 10/J/Q/K");
});

test("handToCardIndices is stable for the same inputs and preserves length", () => {
  const a = handToCardIndices([11, 10, 5], 7);
  const b = handToCardIndices([11, 10, 5], 7);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
});
