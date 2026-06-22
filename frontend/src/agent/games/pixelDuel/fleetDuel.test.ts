/**
 * Fleet duel path (bot-vs-bot OVER THE TUNNEL) — the off-chain logic that the
 * engine's `playOneMatch` duel branch runs, exercised WITHOUT the relay/on-chain
 * shell. It proves the load-bearing parts the engine adds:
 *
 *  1. COMMIT HANDSHAKE: each seat generates its OWN secret template+salt locally
 *     (independent RNG streams — neither learns the other's mask) and only the
 *     32-byte commit crosses. The protocol is then built INLINE with both commits
 *     ordered by `selfParty` — exactly `new PixelDuelProtocol({ A, B })` below.
 *  2. PLAY: the seat bot's `plan` drives build/contest paints to the cap.
 *  3. REVEAL INJECTION: in the reveal phase `placed` is frozen, so the engine's
 *     reveal-phase proposer (read the public `revealed{A,B}` flags, pending seat
 *     proposes its OWN reveal) drives BOTH reveals — `randomMove` never could.
 *  4. SCORING: the protocol opens both commits and scores coverage; balances stay
 *     conserved.
 *
 * The two seats co-sign byte-identical state on the real tunnel, so driving a
 * single shared protocol+state here is faithful to the on-wire run.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  PixelDuelProtocol,
  type PixelDuelState,
  type PixelDuelMove,
  COLOR_A,
  COLOR_B,
  MIN_TEMPLATE_CELLS,
  MAX_TEMPLATE_CELLS,
} from "sui-tunnel-ts/protocol/pixelDuel";
import { verifyCommitment } from "sui-tunnel-ts/core/commitment";
import type { Party, ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";
import {
  makeDuelSeatMaterial,
  createDuelSeatBot,
  type DuelSeatMaterial,
} from "./kit";

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
 * The engine's duel proposer, verbatim: parity during play, but in the reveal
 * phase `placed` is frozen, so the pending seat (by the public `revealed*` flags)
 * proposes its own reveal. Both seats compute the same value from public state.
 */
function duelProposer(st: PixelDuelState): Party {
  if (st.phase === "reveal") return !st.revealedA ? "A" : "B";
  return st.placed % 2 === 0 ? "A" : "B";
}

interface FleetRun {
  final: PixelDuelState;
  selfA: DuelSeatMaterial;
  selfB: DuelSeatMaterial;
}

/** Run the full fleet duel: independent material, commit swap, inline build, drive. */
function runFleetDuel(seedA: number, seedB: number, ctx: ProtocolContext): FleetRun {
  // 1. Each agent generates ONLY its own seat material from its own RNG stream.
  const selfA = makeDuelSeatMaterial("A", mulberry32(seedA));
  const selfB = makeDuelSeatMaterial("B", mulberry32(seedB));

  // 2. Commits swap; each side builds the SAME protocol with both, ordered by seat.
  const protocol = new PixelDuelProtocol({
    templateCommitA: selfA.commit,
    templateCommitB: selfB.commit,
    stake: 500n,
  });

  // Each seat bot holds ONLY its own (mask, salt, color).
  const botA = createDuelSeatBot("A", { rngForSeat: () => mulberry32(7) }, selfA);
  const botB = createDuelSeatBot("B", { rngForSeat: () => mulberry32(9) }, selfB);
  const bots: Record<Party, typeof botA> = { A: botA, B: botB };

  // 3. Drive: whoever the proposer is plans + applies (the on-wire ping-pong).
  let state = protocol.initialState(ctx);
  for (let i = 0; i < 200_000 && !protocol.isTerminal(state); i++) {
    const seat = duelProposer(state);
    const move: PixelDuelMove | null = bots[seat].plan(state);
    assert.ok(move, `seat ${seat} must have a move in phase ${state.phase}`);
    state = protocol.applyMove(state, move!, seat);
  }
  return { final: state, selfA, selfB };
}

describe("fleet duel path (engine off-chain logic)", () => {
  const ctx: ProtocolContext = {
    tunnelId: "fleet-duel-1",
    initialBalances: { a: 500n, b: 500n },
  };

  it("generates independent per-seat material and swaps only 32-byte commits", () => {
    const selfA = makeDuelSeatMaterial("A", mulberry32(1));
    const selfB = makeDuelSeatMaterial("B", mulberry32(2));
    assert.strictEqual(selfA.commit.length, 32, "seat A commit is 32 bytes");
    assert.strictEqual(selfB.commit.length, 32, "seat B commit is 32 bytes");
    assert.strictEqual(selfA.color, COLOR_A);
    assert.strictEqual(selfB.color, COLOR_B);
    // Each commit opens its own mask+salt — what the protocol checks at reveal.
    assert.ok(verifyCommitment(selfA.commit, selfA.mask, selfA.salt));
    assert.ok(verifyCommitment(selfB.commit, selfB.mask, selfB.salt));
    // Independent draws ⇒ the commits differ (different masks/salts).
    assert.notDeepStrictEqual(
      Array.from(selfA.commit),
      Array.from(selfB.commit),
    );
  });

  it("drives two independently-committed bots over the tunnel to a scored terminal", () => {
    const { final, selfA, selfB } = runFleetDuel(11, 22, ctx);

    assert.strictEqual(final.phase, "over", "duel settled");
    assert.ok(final.revealedA, "seat A injected its reveal");
    assert.ok(final.revealedB, "seat B injected its reveal");
    assert.ok([1, 2, 3].includes(final.winner), `winner ${final.winner} in {1,2,3}`);

    // The injected reveals opened the commits each agent swapped at the handshake.
    assert.ok(
      verifyCommitment(final.templateCommitA, final.revealedA!, selfA.salt),
      "seat A reveal opens the commit it swapped",
    );
    assert.ok(
      verifyCommitment(final.templateCommitB, final.revealedB!, selfB.salt),
      "seat B reveal opens the commit it swapped",
    );

    // Each revealed mask is an in-band 0/1 mask.
    for (const mask of [final.revealedA!, final.revealedB!]) {
      let cells = 0;
      for (const v of mask) {
        assert.ok(v === 0 || v === 1, "mask is 0/1");
        if (v === 1) cells++;
      }
      assert.ok(
        cells >= MIN_TEMPLATE_CELLS && cells <= MAX_TEMPLATE_CELLS,
        `mask cells ${cells} in band`,
      );
    }

    // Stake shifted loser→winner (clamped) — balances always sum to the locked total.
    assert.strictEqual(
      final.balanceA + final.balanceB,
      ctx.initialBalances.a + ctx.initialBalances.b,
    );
  });

  it("scores coverage from the final canvas vs each revealed mask (boundary verified)", () => {
    const { final } = runFleetDuel(101, 202, ctx);
    const hits = (mask: Uint8Array, color: number) => {
      let n = 0;
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] === 1 && final.canvas[i] === color) n++;
      }
      return n;
    };
    assert.strictEqual(final.scoreNumA, hits(final.revealedA!, COLOR_A));
    assert.strictEqual(final.scoreNumB, hits(final.revealedB!, COLOR_B));
    const lhs = final.scoreNumA * final.templateCellsB;
    const rhs = final.scoreNumB * final.templateCellsA;
    const expected = lhs > rhs ? 1 : rhs > lhs ? 2 : 3;
    assert.strictEqual(final.winner, expected, "winner matches integer cross-multiply");
  });
});
