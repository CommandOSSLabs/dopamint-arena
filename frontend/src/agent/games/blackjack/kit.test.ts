import { describe, it } from "node:test";
import assert from "node:assert";
import { driveToTerminal } from "@/agent/testHarness";
import { createBlackjackKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("blackjack kit", () => {
  // Small stacks so the game terminates in a few hands; each card costs 4 moves
  // (A commit, B commit, A reveal, B reveal) so the total move count per hand is high.
  // Sized to MIN_BET (1): the bot always bets the minimum, so two equal stacks are a
  // step-1 random walk to ruin (~N² hands) — keep N tiny to terminate within the cap.
  const ctx: ProtocolContext = {
    tunnelId: "bj-1",
    initialBalances: { a: 10n, b: 10n },
  };

  it("uses the SDK commit-reveal protocol", () => {
    const kit = createBlackjackKit(100n);
    assert.strictEqual(kit.id, "blackjack");
    assert.strictEqual(kit.protocol.name, "blackjack.v2");
    assert.ok(kit.moveCodec, "moveCodec must be defined");
    assert.strictEqual(kit.defaultStake, 100n);
  });

  it("the bot bets to open the first round", () => {
    const kit = createBlackjackKit(100n);
    const state = kit.protocol.initialState(ctx);
    const ctx2 = { rngForSeat: () => mulberry32(1) } as never;
    // Round 0 round_over -> next player A owes the bet.
    const move = kit.createBot("A", ctx2).plan(state);
    assert.ok(move, "bot must return a move");
    assert.strictEqual(move.kind, "bet");
  });

  it("drives a full game to terminal with conserved balances", () => {
    const kit = createBlackjackKit(100n);
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(2) });
    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(kit.protocol.isTerminal(result.finalState));
    const balances = kit.protocol.balances(result.finalState);
    assert.strictEqual(
      balances.a + balances.b,
      ctx.initialBalances.a + ctx.initialBalances.b,
    );
  });
});
