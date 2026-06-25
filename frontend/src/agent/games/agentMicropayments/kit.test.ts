import { describe, it } from "node:test";
import assert from "node:assert";
import { driveToTerminal } from "@/agent/testHarness";
import { createAgentMicropaymentsKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("agentMicropayments kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "micro-1",
    initialBalances: { a: 100n, b: 100n },
  };

  it("uses the agent-micropayments protocol domain", () => {
    const kit = createAgentMicropaymentsKit(10n, 100n);
    assert.strictEqual(kit.id, "agent-micropayments");
    assert.strictEqual(kit.protocol.name, "agent_micropayments.v1");
  });

  it("the consumer bot pays the provider until the budget settles, conserving the pot", () => {
    const kit = createAgentMicropaymentsKit(10n, 100n);
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(2) });

    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(kit.protocol.isTerminal(result.finalState));
    const bal = kit.protocol.balances(result.finalState);
    assert.strictEqual(bal.a, 0n); // consumer drained its budget
    assert.strictEqual(bal.b, 200n); // provider earned the full locked total
    assert.strictEqual(bal.a + bal.b, 200n); // conserved
    assert.strictEqual(result.accepted, 10); // 100 budget / 10 per request
  });

  it("the move codec round-trips a bigint amount", () => {
    const kit = createAgentMicropaymentsKit(10n, 100n);
    const move = { amount: 42n };
    assert.deepStrictEqual(
      kit.moveCodec!.decode(kit.moveCodec!.encode(move)),
      move,
    );
  });
});
