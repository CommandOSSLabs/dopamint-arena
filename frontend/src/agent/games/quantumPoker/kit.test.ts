import { describe, it } from "node:test";
import assert from "node:assert";
import { driveToTerminal } from "@/agent/testHarness";
import { createQuantumPokerKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

describe("quantum poker kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "qp-1",
    initialBalances: { a: 10000n, b: 10000n },
  };

  it("uses the quantum poker protocol domain", () => {
    const kit = createQuantumPokerKit(100n);
    assert.strictEqual(kit.protocol.name, "quantum_poker.v2");
  });

  it("drives at least one hand to completion without rejected moves", () => {
    const kit = createQuantumPokerKit(100n);
    const botA = kit.createBot("A", { rngForSeat: () => Math.random });
    const botB = kit.createBot("B", { rngForSeat: () => Math.random });
    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(kit.protocol.isTerminal(result.finalState));
    const balances = kit.protocol.balances(result.finalState);
    assert.strictEqual(balances.a + balances.b, ctx.initialBalances.a + ctx.initialBalances.b);
  });
});
