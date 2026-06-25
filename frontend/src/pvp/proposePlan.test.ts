import { test } from "node:test";
import assert from "node:assert/strict";
import { proposePlan } from "./proposePlan";

const base = {
  myRole: "A" as const,
  turnRole: "A" as const,
  terminal: false,
  hasPending: false,
  auto: true,
  hasInput: false,
  stepMs: 250,
};

test("never proposes off-turn", () => {
  assert.equal(proposePlan({ ...base, turnRole: "B" }).delayMs, null);
});

test("never proposes once terminal", () => {
  assert.equal(proposePlan({ ...base, terminal: true }).delayMs, null);
});

test("never proposes while a proposal awaits its ACK", () => {
  assert.equal(proposePlan({ ...base, hasPending: true }).delayMs, null);
});

test("a bot seat is paced by stepMs", () => {
  assert.equal(proposePlan({ ...base, auto: true }).delayMs, 250);
});

test("a manual seat with real input proposes immediately", () => {
  assert.equal(
    proposePlan({ ...base, auto: false, hasInput: true }).delayMs,
    0,
  );
});

test("a manual seat with no input keeps the idle pace (world still advances)", () => {
  assert.equal(
    proposePlan({ ...base, auto: false, hasInput: false }).delayMs,
    250,
  );
});

test("eager input never overrides the off-turn / pending / terminal guards", () => {
  const input = { ...base, auto: false, hasInput: true };
  assert.equal(proposePlan({ ...input, turnRole: "B" }).delayMs, null);
  assert.equal(proposePlan({ ...input, hasPending: true }).delayMs, null);
  assert.equal(proposePlan({ ...input, terminal: true }).delayMs, null);
});
