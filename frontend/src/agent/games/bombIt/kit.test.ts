import { describe, it } from "node:test";
import assert from "node:assert";
import { driveToTerminal } from "@/agent/testHarness";
import { createBombItKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("bombIt kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "bomb-1",
    initialBalances: { a: 100n, b: 100n },
  };

  it("uses the bomb-it protocol domain", () => {
    const kit = createBombItKit(100n);
    assert.strictEqual(kit.id, "bomb-it");
    assert.strictEqual(kit.protocol.name, "bomb_it.v1");
  });

  it("drives a full self-play game to terminal with conserved balances", () => {
    const kit = createBombItKit(100n);
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(2) });
    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(kit.protocol.isTerminal(result.finalState));
    assert.ok(result.accepted > 0);
    const balances = kit.protocol.balances(result.finalState);
    assert.strictEqual(balances.a + balances.b, ctx.initialBalances.a + ctx.initialBalances.b);
  });

  it("a bot proposes only on its own tick (A even, B odd)", () => {
    const kit = createBombItKit(100n);
    const state = kit.protocol.initialState(ctx); // tick 0 -> A's turn
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(3) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(4) });
    assert.notStrictEqual(botA.plan(state), null);
    assert.strictEqual(botB.plan(state), null);
  });
});
