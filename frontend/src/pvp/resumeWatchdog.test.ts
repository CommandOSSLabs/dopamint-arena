import assert from "node:assert/strict";
import test from "node:test";
import { resumeWatchdogShouldArm } from "./resumeWatchdog";

// The safety invariant: a clean resume on our OWN turn (nothing pending) must NOT arm the watchdog —
// resume already succeeded, and arming would let a false timeout tear down a live, healthy match.
test("a clean own-turn resume does not arm the watchdog", () => {
  assert.equal(resumeWatchdogShouldArm(false, false), false);
});

test("arms when it's the peer's turn (we're waiting on their move)", () => {
  assert.equal(resumeWatchdogShouldArm(false, true), true);
});

test("arms when we have an unacked pending move out, even on our own turn", () => {
  assert.equal(resumeWatchdogShouldArm(true, false), true);
  assert.equal(resumeWatchdogShouldArm(true, true), true);
});
