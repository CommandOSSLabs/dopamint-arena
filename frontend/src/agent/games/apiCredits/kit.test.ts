import { describe, it } from "node:test";
import assert from "node:assert";
import { driveToTerminal } from "@/agent/testHarness";
import { createApiCreditsKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("apiCredits kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "credits-1",
    initialBalances: { a: 100n, b: 100n },
  };

  it("uses the api-credits protocol domain", () => {
    const kit = createApiCreditsKit(10n, 100n);
    assert.strictEqual(kit.id, "api-credits");
    assert.strictEqual(kit.protocol.name, "api_credits.v1");
  });

  it("the client bot spends every credit to settlement, conserving the pot", () => {
    const kit = createApiCreditsKit(10n, 100n);
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(2) });

    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(kit.protocol.isTerminal(result.finalState));
    const bal = kit.protocol.balances(result.finalState);
    assert.strictEqual(bal.a, 0n); // all credits spent
    assert.strictEqual(bal.b, 200n); // provider earned the full locked total
    assert.strictEqual(bal.a + bal.b, 200n); // conserved
    assert.strictEqual(result.accepted, 10); // 100 prepaid / 10 per call
  });
});
