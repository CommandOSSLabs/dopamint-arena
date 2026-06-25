import { describe, it } from "node:test";
import assert from "node:assert";
import { ApiCreditsProtocol } from "./apiCredits";
import type { ProtocolContext } from "./Protocol";

const ctx: ProtocolContext = {
  tunnelId: "credits-1",
  initialBalances: { a: 100n, b: 0n },
};

describe("ApiCreditsProtocol", () => {
  it("starts with the client holding the prepaid balance", () => {
    const p = new ApiCreditsProtocol(10n);
    const s = p.initialState(ctx);
    assert.strictEqual(s.client, 100n);
    assert.strictEqual(s.provider, 0n);
    assert.strictEqual(s.calls, 0n);
  });

  it("a call burns the fixed cost client -> provider, conserving the total", () => {
    const p = new ApiCreditsProtocol(10n);
    const s1 = p.applyMove(p.initialState(ctx), { kind: "call" }, "A");
    assert.strictEqual(s1.client, 90n);
    assert.strictEqual(s1.provider, 10n);
    assert.strictEqual(s1.calls, 1n);
    assert.strictEqual(s1.client + s1.provider, 100n);
  });

  it("only the client (A) may call, and not once credits run out", () => {
    const p = new ApiCreditsProtocol(10n);
    const s = p.initialState(ctx);
    assert.throws(() => p.applyMove(s, { kind: "call" }, "B"));
    const broke = { client: 5n, provider: 95n, total: 100n, calls: 0n };
    assert.throws(() => p.applyMove(broke, { kind: "call" }, "A"));
  });

  it("spends all credits to a terminal state, provider earning the total", () => {
    const p = new ApiCreditsProtocol(10n);
    let s = p.initialState(ctx);
    let guard = 0;
    while (!p.isTerminal(s) && guard++ < 1000) {
      const move = p.randomMove(s, "A", Math.random);
      assert.notStrictEqual(move, null);
      s = p.applyMove(s, move!, "A");
    }
    assert.ok(p.isTerminal(s));
    assert.strictEqual(s.client, 0n);
    assert.strictEqual(s.provider, 100n);
    assert.strictEqual(s.calls, 10n);
  });

  it("is terminal when the remaining balance can't cover a call", () => {
    const p = new ApiCreditsProtocol(30n);
    // 100 -> 70 -> 40 -> 10, then 10 < 30 is terminal (dust remains with the client).
    let s = p.initialState(ctx);
    for (let i = 0; i < 3; i++) s = p.applyMove(s, { kind: "call" }, "A");
    assert.strictEqual(s.client, 10n);
    assert.ok(p.isTerminal(s));
    assert.strictEqual(p.randomMove(s, "A", Math.random), null);
  });

  it("encodes state canonically with its domain tag", () => {
    const p = new ApiCreditsProtocol(10n);
    const a = p.encodeState(p.initialState(ctx));
    assert.ok(Buffer.from(a).toString().includes("api_credits.v1"));
  });
});
