import { describe, it } from "node:test";
import assert from "node:assert";
import { protocols } from "sui-tunnel-ts";
import { driveToTerminal } from "@/agent/testHarness";
import { createTicTacToeKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("ticTacToe kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "ttt-1",
    initialBalances: { a: 100n, b: 100n },
  };

  it("uses the multi-game frontend protocol domain", () => {
    const kit = createTicTacToeKit(3, 10n);
    assert.strictEqual(kit.protocol.name, "tic_tac_toe.multi.v1");
    assert.notStrictEqual(kit.protocol.name, new protocols.TicTacToeProtocol(10n).name);
  });

  it("drives a full multi-game session to terminal with conserved balances", () => {
    const kit = createTicTacToeKit(3, 10n);
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(2) });
    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(kit.protocol.isTerminal(result.finalState));
    const balances = kit.protocol.balances(result.finalState);
    assert.strictEqual(balances.a + balances.b, ctx.initialBalances.a + ctx.initialBalances.b);
  });

  it("is deterministic and idempotent on replayed state", () => {
    const kit = createTicTacToeKit(1, 10n);
    const state = kit.protocol.initialState(ctx);
    const bot = kit.createBot("A", { rngForSeat: () => mulberry32(42) });
    const move1 = bot.plan(state);
    const move2 = bot.plan(state);
    assert.deepStrictEqual(move1, move2);
  });

  it("fast mode is deterministic with a seeded RNG", () => {
    const kit = createTicTacToeKit(1, 10n, { difficulty: "fast" });
    const state = kit.protocol.initialState(ctx);
    const bot = kit.createBot("A", { rngForSeat: () => mulberry32(7) });
    const move1 = bot.plan(state);
    const move2 = bot.plan(state);
    assert.deepStrictEqual(move1, move2);
  });
});
