import { describe, it } from "node:test";
import assert from "node:assert";
import { driveToTerminal } from "@/agent/testHarness";
import { createBattleshipKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";
import { BattleshipProtocol } from "sui-tunnel-ts/protocol/battleship";
import { randomFleetSecret } from "@/games/battleship/engine/selfPlay";

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("battleship kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "bs-1",
    initialBalances: { a: 100n, b: 100n },
  };

  it("uses the sdk battleship protocol domain", () => {
    const kit = createBattleshipKit(10n);
    assert.strictEqual(kit.protocol.name, "battleship.v2");
  });

  it("drives a full game to terminal with conserved balances and no rejected moves", () => {
    const kit = createBattleshipKit(10n);
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

// Drive A's fleet to a state where B (the bot under test) is the defender of a
// MISS, then check whether B's answer pipelines a `next`.
function missAnswerOf(pipeline: boolean) {
  const ctx = { rngForSeat: () => () => 0.5 };
  const proto = new BattleshipProtocol(100n);
  const sA = randomFleetSecret(seeded(1));
  const sB = randomFleetSecret(seeded(2));
  const kit = createBattleshipKit(100n, { secret: sB, pipeline });
  const botB = kit.createBot("B", ctx);
  let st = proto.initialState({
    tunnelId: "0x1",
    initialBalances: { a: 1000n, b: 1000n },
  });
  st = proto.applyMove(st, { kind: "commit", commitment: sA.commitment }, "A");
  st = proto.applyMove(st, { kind: "commit", commitment: sB.commitment }, "B");
  // A shoots a WATER cell of B's board (guaranteed miss).
  const water = sB.board.findIndex((v) => v === 0);
  st = proto.applyMove(st, { kind: "shoot", cell: water }, "A");
  return botB.plan(st);
}
function seeded(s: number): () => number {
  let x = s >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0), x / 0x100000000);
}

it("pipeline:true makes the bot's miss-answer carry a next shot", () => {
  const m = missAnswerOf(true);
  assert.strictEqual(m?.kind, "answer");
  assert.strictEqual((m as { isHit: boolean }).isHit, false);
  assert.strictEqual(typeof (m as { next?: number }).next, "number");
});
it("pipeline:false makes the bot's miss-answer bare", () => {
  const m = missAnswerOf(false);
  assert.strictEqual(m?.kind, "answer");
  assert.strictEqual((m as { isHit: boolean }).isHit, false);
  assert.strictEqual((m as { next?: number }).next, undefined);
});
