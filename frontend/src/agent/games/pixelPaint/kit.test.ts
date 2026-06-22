import { describe, it } from "node:test";
import assert from "node:assert";
import { driveToTerminal } from "@/agent/testHarness";
import { createPixelPaintKit } from "./kit";
import { DESIGNS, projectDesign } from "./designs";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";
import type { PixelPaintState } from "sui-tunnel-ts/protocol/pixelPaint";

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("pixel-paint kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "pp-1",
    initialBalances: { a: 100n, b: 100n },
  };

  it("uses the frontend pixel-war protocol domain", () => {
    assert.strictEqual(
      createPixelPaintKit().protocol.name,
      "pixel_paint.war.v1",
    );
  });

  it("two design-bots wage a legal territory war to a settled terminal", () => {
    const kit = createPixelPaintKit({ width: 16, height: 16, cap: 64 });
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(2) });
    const r = driveToTerminal(kit, botA, botB, ctx);
    const s = r.finalState;

    assert.ok(kit.protocol.isTerminal(s));
    assert.strictEqual(s.placed, 64);
    // A decisive or drawn winner, consistent with territory + balances.
    assert.ok([1, 2, 3].includes(s.winner));
    const bal = kit.protocol.balances(s);
    assert.strictEqual(bal.a + bal.b, ctx.initialBalances.a + ctx.initialBalances.b);
    if (s.winner === 1) {
      assert.ok(s.ownedA > s.ownedB && bal.a > bal.b);
    } else if (s.winner === 2) {
      assert.ok(s.ownedB > s.ownedA && bal.b > bal.a);
    } else {
      assert.strictEqual(bal.a, ctx.initialBalances.a); // draw → no shift
    }
  });

  it("terminates by full lock on a high cap + low overwrite limit (no deadlock)", () => {
    // paint pool = 8*8*2 = 128 < cap, so the board locks before the cap; the
    // harness's "no progress" guard must never fire.
    const kit = createPixelPaintKit({
      width: 8,
      height: 8,
      cap: 100000,
      overwriteLimit: 2,
    });
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(3) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(4) });
    const r = driveToTerminal(kit, botA, botB, ctx);
    assert.ok(kit.protocol.isTerminal(r.finalState));
    assert.strictEqual(r.finalState.locked, 64); // every cell locked
    assert.ok(r.finalState.placed < 100000);
  });

  it("paints the target: in-design cells carry the target color once complete", () => {
    const kit = createPixelPaintKit({
      width: 16,
      height: 16,
      cap: 400,
      target: DESIGNS.heart,
    });
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(7) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(8) });
    const r = driveToTerminal(kit, botA, botB, ctx);

    const want = projectDesign(DESIGNS.heart, 16, 16);
    let inDesign = 0;
    let correct = 0;
    for (let i = 0; i < want.length; i++) {
      if (want[i] === 0) continue;
      inDesign++;
      if (r.finalState.canvas[i] === want[i]) correct++;
    }
    assert.ok(inDesign > 0, "heart should project some cells");
    // With cap 400 >> heart pixel count, both bots converge the whole design.
    assert.strictEqual(correct, inDesign);
  });

  it("two scene-bots race a shared stencil to a fully-locked, all-correct terminal", () => {
    // Walrus is 16×12, so it tiles the 16×12 canvas exactly (no clipping). A cap
    // far above the paint pool forces termination by full stencil lock, not cap.
    const W = 16;
    const H = 12;
    const kit = createPixelPaintKit({
      mode: "scene",
      scene: DESIGNS.walrus,
      width: W,
      height: H,
      cap: 100000,
    });
    assert.strictEqual(kit.protocol.name, "pixel_paint.scene.v1");

    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(11) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(12) });
    const r = driveToTerminal(kit, botA, botB, ctx);
    const s = r.finalState as PixelPaintState;

    assert.ok(kit.protocol.isTerminal(s));
    // Settled by locking every stencil cell, well under the cap.
    assert.strictEqual(s.locked, s.targetCellCount);
    assert.ok(s.placed < 100000);

    // Only stencil cells are ever painted, and only at their required color.
    const stencil = projectDesign(DESIGNS.walrus, W, H);
    let painted = 0;
    for (let i = 0; i < stencil.length; i++) {
      if (stencil[i] === 0) {
        assert.strictEqual(s.canvas[i], 0, `off-scene cell ${i} must stay blank`);
      } else {
        assert.strictEqual(s.canvas[i], stencil[i], `cell ${i} must match stencil`);
        painted++;
      }
    }
    assert.ok(painted > 0, "walrus should project some cells");
    assert.strictEqual(painted, s.targetCellCount);
    // Every stencil cell was banked, split between the two seats.
    assert.strictEqual(s.correctA + s.correctB, s.targetCellCount);

    // Settles on the tunnel exactly like tic-tac-toe: balances sum to the pot.
    const bal = kit.protocol.balances(s);
    assert.strictEqual(
      bal.a + bal.b,
      ctx.initialBalances.a + ctx.initialBalances.b,
    );
    assert.ok([1, 2, 3].includes(s.winner));
  });
});
