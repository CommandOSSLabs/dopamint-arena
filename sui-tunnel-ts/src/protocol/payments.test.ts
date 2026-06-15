import { test } from "node:test";
import assert from "node:assert/strict";
import { PaymentsProtocol } from "./payments";
import { toHex } from "../core/bytes";

const proto = new PaymentsProtocol();
const ctx = { tunnelId: "0xab", initialBalances: { a: 100n, b: 100n } };

test("initialState reflects locked balances and total", () => {
  const s = proto.initialState(ctx);
  assert.equal(s.balanceA, 100n);
  assert.equal(s.balanceB, 100n);
  assert.equal(s.total, 200n);
  assert.equal(s.count, 0n);
});

test("applyMove transfers and conserves total", () => {
  let s = proto.initialState(ctx);
  s = proto.applyMove(s, { from: "A", amount: 30n }, "A");
  assert.equal(s.balanceA, 70n);
  assert.equal(s.balanceB, 130n);
  assert.equal(s.count, 1n);
  s = proto.applyMove(s, { from: "B", amount: 10n }, "B");
  assert.equal(s.balanceA, 80n);
  assert.equal(s.balanceB, 120n);
  assert.equal(s.balanceA + s.balanceB, 200n);
});

test("applyMove rejects overspend, non-positive, and signer mismatch", () => {
  const s = proto.initialState(ctx);
  assert.throws(() => proto.applyMove(s, { from: "A", amount: 101n }, "A"));
  assert.throws(() => proto.applyMove(s, { from: "A", amount: 0n }, "A"));
  assert.throws(() => proto.applyMove(s, { from: "A", amount: 10n }, "B"));
});

test("applyMove is pure (does not mutate input state)", () => {
  const s = proto.initialState(ctx);
  proto.applyMove(s, { from: "A", amount: 30n }, "A");
  assert.equal(s.balanceA, 100n); // unchanged
});

test("encodeState is deterministic and changes with state", () => {
  const s0 = proto.initialState(ctx);
  const s1 = proto.applyMove(s0, { from: "A", amount: 1n }, "A");
  assert.equal(toHex(proto.encodeState(s0)), toHex(proto.encodeState(s0)));
  assert.notEqual(toHex(proto.encodeState(s0)), toHex(proto.encodeState(s1)));
});

test("balances sum to total, randomMove yields a legal move", () => {
  let s = proto.initialState(ctx);
  const rng = (() => {
    let x = 0.42;
    return () => (x = (x * 9301 + 49297) % 1) || 0.5;
  })();
  for (let i = 0; i < 100; i++) {
    const by = i % 2 === 0 ? "A" : "B";
    const m = proto.randomMove(s, by, rng);
    if (!m) continue;
    s = proto.applyMove(s, m, by);
    const bal = proto.balances(s);
    assert.equal(bal.a + bal.b, 200n);
    assert.ok(bal.a >= 0n && bal.b >= 0n);
  }
  assert.ok(!proto.isTerminal());
});
