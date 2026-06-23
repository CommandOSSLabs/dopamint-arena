import { describe, it } from "node:test";
import assert from "node:assert";
import {
  COLOR_A,
  COLOR_B,
  MIN_TEMPLATE_CELLS,
  MAX_TEMPLATE_CELLS,
  type PixelDuelState,
} from "sui-tunnel-ts/protocol/pixelDuel";
import { verifyCommitment } from "sui-tunnel-ts/core/commitment";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";
import { driveToTerminal } from "@/agent/testHarness";
import { GAME_KITS } from "@/agent/gameKit";
import { createPixelDuelKit } from "./duelKit";

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Independent re-derivation of one seat's coverage from PUBLIC final state: count
 * the revealed mask cells the seat painted its OWN color. This is the same
 * definition the protocol scores by; recomputing it here proves the protocol's
 * `scoreNum`/`winner` actually reflect the final canvas vs each revealed mask
 * (not a stale or fabricated snapshot).
 */
function coverageHits(
  canvas: Uint8Array,
  mask: Uint8Array,
  seatColor: number,
): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1 && canvas[i] === seatColor) n++;
  }
  return n;
}

/** Recompute the winner from coverage by integer cross-multiplication. */
function decideWinner(state: PixelDuelState): 1 | 2 | 3 {
  const lhs = state.scoreNumA * state.templateCellsB;
  const rhs = state.scoreNumB * state.templateCellsA;
  return lhs > rhs ? 1 : rhs > lhs ? 2 : 3;
}

describe("pixelDuel kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "duel-1",
    initialBalances: { a: 1000n, b: 1000n },
  };

  it("uses the pixel_duel.v1 protocol domain", () => {
    const kit = createPixelDuelKit();
    assert.strictEqual(kit.protocol.name, "pixel_duel.v1");
  });

  it("drives two bots to a scored terminal with both templates revealed", () => {
    const kit = createPixelDuelKit({ seed: 1 });
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(11) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(22) });

    const result = driveToTerminal(kit, botA, botB, ctx);
    const final = result.finalState as PixelDuelState;

    // Terminal: the duel has been scored and settled.
    assert.ok(kit.protocol.isTerminal(final));
    assert.strictEqual(final.phase, "over");

    // BOTH secret templates revealed (the kit drove both reveals).
    assert.ok(final.revealedA, "seat A template must be revealed");
    assert.ok(final.revealedB, "seat B template must be revealed");

    // Each revealed template is a legal in-band 0/1 mask.
    for (const mask of [final.revealedA!, final.revealedB!]) {
      let cells = 0;
      for (const v of mask) {
        assert.ok(v === 0 || v === 1, "template must be a 0/1 mask");
        if (v === 1) cells++;
      }
      assert.ok(
        cells >= MIN_TEMPLATE_CELLS && cells <= MAX_TEMPLATE_CELLS,
        `template cells ${cells} must be in [${MIN_TEMPLATE_CELLS},${MAX_TEMPLATE_CELLS}]`,
      );
    }

    // A decisive-or-draw winner (paint can never produce winner 0 at terminal).
    assert.ok([1, 2, 3].includes(final.winner), `winner ${final.winner} in {1,2,3}`);

    // Stake is shifted loser→winner (clamped), so balances always sum to total.
    const balances = kit.protocol.balances(final);
    assert.strictEqual(
      balances.a + balances.b,
      ctx.initialBalances.a + ctx.initialBalances.b,
    );
    assert.strictEqual(balances.a + balances.b, final.total);

    // The protocol's score MUST match an independent coverage recomputation from
    // the final canvas vs each revealed mask — the boundary we are verifying.
    const hitsA = coverageHits(final.canvas, final.revealedA!, COLOR_A);
    const hitsB = coverageHits(final.canvas, final.revealedB!, COLOR_B);
    assert.strictEqual(final.scoreNumA, hitsA, "seat A coverage must match scoreNumA");
    assert.strictEqual(final.scoreNumB, hitsB, "seat B coverage must match scoreNumB");
    assert.strictEqual(final.winner, decideWinner(final), "winner must match cross-multiply");
  });

  it("commits each seat's revealed template against the protocol commitment", () => {
    // The reveal the kit's bot emits must open the commitment the kit baked into
    // the protocol — i.e. mask+salt round-trip through computeCommitment.
    const kit = createPixelDuelKit({ seed: 7 });
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(11) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(22) });
    const final = driveToTerminal(kit, botA, botB, ctx).finalState as PixelDuelState;

    // A reveal that verifies stored the template; both commits must be openable.
    assert.ok(
      verifyCommitment(final.templateCommitA, final.revealedA!, saltFromReveal(botA)),
      "seat A reveal opens its commitment",
    );
    assert.ok(
      verifyCommitment(final.templateCommitB, final.revealedB!, saltFromReveal(botB)),
      "seat B reveal opens its commitment",
    );
  });

  it("replays identically for a fixed seed", () => {
    const a = createPixelDuelKit({ seed: 99 });
    const b = createPixelDuelKit({ seed: 99 });
    // Same committed templates ⇒ same on-wire initial commitments.
    const stateA = a.protocol.initialState(ctx);
    const stateB = b.protocol.initialState(ctx);
    assert.strictEqual(a.stateHash(stateA), b.stateHash(stateB));
  });

  it("is registered in the global kit registry", () => {
    assert.ok(GAME_KITS["pixel-duel"], "pixel-duel kit is registered");
    assert.strictEqual(GAME_KITS["pixel-duel"].protocol.name, "pixel_duel.v1");
  });
});

/**
 * Pull the salt a bot would reveal by planning in a synthetic reveal-phase state.
 * The bot's reveal is `{ kind: "reveal", template, salt }`; we only need its salt.
 */
function saltFromReveal(
  bot: ReturnType<ReturnType<typeof createPixelDuelKit>["createBot"]>,
): Uint8Array {
  const move = bot.plan({ phase: "reveal" } as PixelDuelState);
  assert.ok(move && move.kind === "reveal", "bot must reveal in the reveal phase");
  return move.salt;
}
