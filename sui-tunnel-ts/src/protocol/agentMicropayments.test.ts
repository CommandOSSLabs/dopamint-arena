import { describe, it } from "node:test";
import assert from "node:assert";
import { AgentMicropaymentsProtocol } from "./agentMicropayments";
import type { ProtocolContext } from "./Protocol";

const ctx: ProtocolContext = {
  tunnelId: "micro-1",
  initialBalances: { a: 100n, b: 0n },
};

describe("AgentMicropaymentsProtocol", () => {
  it("starts with the consumer holding the full budget", () => {
    const p = new AgentMicropaymentsProtocol(10n);
    const s = p.initialState(ctx);
    assert.strictEqual(s.consumer, 100n);
    assert.strictEqual(s.provider, 0n);
    assert.strictEqual(s.total, 100n);
  });

  it("a request shifts funds consumer -> provider, conserving the total", () => {
    const p = new AgentMicropaymentsProtocol(10n);
    const s1 = p.applyMove(p.initialState(ctx), { amount: 10n }, "A");
    assert.strictEqual(s1.consumer, 90n);
    assert.strictEqual(s1.provider, 10n);
    assert.strictEqual(s1.requests, 1n);
    assert.strictEqual(s1.consumer + s1.provider, 100n);
  });

  it("only the consumer (A) may pay, and never beyond the budget", () => {
    const p = new AgentMicropaymentsProtocol(10n);
    const s = p.initialState(ctx);
    assert.throws(() => p.applyMove(s, { amount: 10n }, "B"));
    assert.throws(() => p.applyMove(s, { amount: 101n }, "A"));
    assert.throws(() => p.applyMove(s, { amount: 0n }, "A"));
  });

  it("drains the budget to a terminal state, with the provider earning the total", () => {
    const p = new AgentMicropaymentsProtocol(10n);
    let s = p.initialState(ctx);
    let guard = 0;
    while (!p.isTerminal(s) && guard++ < 1000) {
      const move = p.randomMove(s, "A", Math.random);
      assert.notStrictEqual(move, null);
      s = p.applyMove(s, move!, "A");
    }
    assert.ok(p.isTerminal(s));
    assert.strictEqual(s.consumer, 0n);
    assert.strictEqual(s.provider, 100n);
    assert.strictEqual(s.requests, 10n);
  });

  it("pays the remainder on the final request when it's below the price", () => {
    const p = new AgentMicropaymentsProtocol(30n);
    // 100 / 30 -> 30, 30, 30, then 10 (remainder).
    let s = p.initialState(ctx);
    for (let i = 0; i < 3; i++) s = p.applyMove(s, { amount: 30n }, "A");
    const last = p.randomMove(s, "A", Math.random);
    assert.deepStrictEqual(last, { amount: 10n });
  });

  it("encodes state canonically with its domain tag", () => {
    const p = new AgentMicropaymentsProtocol(10n);
    const s = p.initialState(ctx);
    const a = p.encodeState(s);
    const b = p.encodeState(p.initialState(ctx));
    assert.deepStrictEqual(a, b);
    assert.ok(
      Buffer.from(a).toString().includes("agent_micropayments.v1"),
      "encoding carries the protocol domain",
    );
  });
});
