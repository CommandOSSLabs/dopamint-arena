import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, INITIAL } from "./seatControlState";

test("hover on attract → inviting; unhover → back to attract", () => {
  const inviting = reduce(INITIAL, { type: "hover" });
  assert.equal(inviting.state, "inviting");
  assert.equal(reduce(inviting, { type: "unhover" }).state, "attract");
});

test("overlay 'Return to Home' (goHome while inviting) just dismisses → attract", () => {
  const inviting = reduce(INITIAL, { type: "hover" });
  assert.equal(reduce(inviting, { type: "goHome" }).state, "attract");
});

test("takeOver while inviting hands the seat to the human → live", () => {
  const inviting = reduce(INITIAL, { type: "hover" });
  assert.deepEqual(reduce(inviting, { type: "takeOver" }), { state: "live" });
});

test("in live, goHome exits to the attract floor", () => {
  const live = { state: "live" } as const;
  assert.deepEqual(reduce(live, { type: "goHome" }), INITIAL);
});

test("events that don't apply to the current state are ignored", () => {
  assert.deepEqual(reduce(INITIAL, { type: "takeOver" }), INITIAL);
});
