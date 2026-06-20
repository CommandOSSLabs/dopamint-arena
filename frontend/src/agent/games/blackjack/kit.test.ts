import { describe, it } from "node:test";
import assert from "node:assert";
import { protocols } from "sui-tunnel-ts";
import { driveToTerminal } from "@/agent/testHarness";
import { createBlackjackKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

describe("blackjack kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "bj-1",
    initialBalances: { a: 1000n, b: 1000n },
  };

  it("uses the variable-bet frontend protocol domain", () => {
    const kit = createBlackjackKit(100n);
    assert.strictEqual(kit.protocol.name, "blackjack.bet.v1");
    assert.notStrictEqual(kit.protocol.name, new protocols.BlackjackProtocol(100n).name);
  });

  it("drives a full game to terminal with conserved balances", () => {
    const kit = createBlackjackKit(100n);
    const botA = kit.createBot("A", { rngForSeat: () => Math.random });
    const botB = kit.createBot("B", { rngForSeat: () => Math.random });
    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(kit.protocol.isTerminal(result.finalState));
    const balances = kit.protocol.balances(result.finalState);
    assert.strictEqual(balances.a + balances.b, ctx.initialBalances.a + ctx.initialBalances.b);
  });
});
