import { describe, it } from "node:test";
import assert from "node:assert";
import { createWorldCanvasKit } from "./kit";
import type { ProtocolContext, Party } from "sui-tunnel-ts/protocol/Protocol";

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("worldCanvas kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "world-canvas-1",
    initialBalances: { a: 100n, b: 100n },
  };

  it("uses the world-canvas protocol domain", () => {
    const kit = createWorldCanvasKit(100n);
    assert.strictEqual(kit.id, "world-canvas");
    assert.strictEqual(kit.protocol.name, "world_canvas.v1");
  });

  it("a bot proposes a legal paint that the protocol accepts and advances state", () => {
    const kit = createWorldCanvasKit(100n);
    const state = kit.protocol.initialState(ctx);
    const bot = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    const move = bot.plan(state);
    assert.notStrictEqual(move, null);
    // The protocol accepts the bot's move (no throw) and it strictly advances.
    const next = kit.protocol.applyMove(state, move!, "A");
    assert.notStrictEqual(kit.stateHash(next), kit.stateHash(state));
  });

  it("is deterministic: the same seed yields the same paint", () => {
    const kit = createWorldCanvasKit(100n);
    const state = kit.protocol.initialState(ctx);
    const bot1 = kit.createBot("A", { rngForSeat: () => mulberry32(7) });
    const bot2 = kit.createBot("A", { rngForSeat: () => mulberry32(7) });
    assert.deepStrictEqual(bot1.plan(state), bot2.plan(state));
  });

  it("both seats may paint concurrently (free mode, no turn constraint)", () => {
    const kit = createWorldCanvasKit(100n);
    const state = kit.protocol.initialState(ctx);
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(3) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(4) });
    // Unlike turn-based games, both seats can plan a move from the same state.
    assert.notStrictEqual(botA.plan(state), null);
    assert.notStrictEqual(botB.plan(state), null);
  });

  it("drives a bounded collaborative session, conserving locked balances", () => {
    const kit = createWorldCanvasKit(100n);
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(2) });
    let state = kit.protocol.initialState(ctx);
    // Free mode is effectively continuous (terminal only at an astronomical
    // cap), so drive a fixed paint budget instead of to terminal, asserting
    // every paint is a legal, strictly-advancing co-signed move.
    for (let i = 0; i < 64; i++) {
      const by: Party = i % 2 === 0 ? "A" : "B";
      const bot = by === "A" ? botA : botB;
      const move = bot.plan(state);
      assert.notStrictEqual(move, null, `paint ${i} should be legal`);
      const next = kit.protocol.applyMove(state, move!, by);
      assert.notStrictEqual(kit.stateHash(next), kit.stateHash(state));
      bot.confirm(next, move!);
      state = next;
    }
    assert.ok(!kit.protocol.isTerminal(state));
    const balances = kit.protocol.balances(state);
    // Free/draw mode: balances are locked at open and never shift.
    assert.strictEqual(balances.a, ctx.initialBalances.a);
    assert.strictEqual(balances.b, ctx.initialBalances.b);
    assert.strictEqual(
      balances.a + balances.b,
      ctx.initialBalances.a + ctx.initialBalances.b,
    );
  });
});
