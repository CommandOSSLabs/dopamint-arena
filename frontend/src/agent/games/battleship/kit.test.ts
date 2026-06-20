import { describe, it } from "node:test";
import assert from "node:assert";
import { driveToTerminal } from "@/agent/testHarness";
import { createBattleshipKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

describe("battleship kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "bs-1",
    initialBalances: { a: 100n, b: 100n },
  };

  it("uses the frontend battleship protocol domain", () => {
    const kit = createBattleshipKit(10n);
    assert.strictEqual(kit.protocol.name, "battleship.v1");
  });

  it("drives a full game to terminal with conserved balances and no rejected moves", () => {
    const kit = createBattleshipKit(10n);
    const botA = kit.createBot("A", { rngForSeat: () => Math.random });
    const botB = kit.createBot("B", { rngForSeat: () => Math.random });
    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(kit.protocol.isTerminal(result.finalState));
    const balances = kit.protocol.balances(result.finalState);
    assert.strictEqual(balances.a + balances.b, ctx.initialBalances.a + ctx.initialBalances.b);
  });
});
