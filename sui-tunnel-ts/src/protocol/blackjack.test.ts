import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BlackjackProtocol,
  BlackjackState,
  BlackjackMove,
  SlotSecret,
  WAGER,
  deriveRank,
  getPlayerParty,
  getDealerParty,
} from "./blackjack";
import { computeCommitment } from "../core/commitment";

const proto = new BlackjackProtocol();
const ctx = { tunnelId: "0xab", initialBalances: { a: 1000n, b: 1000n } };
const fresh = (): BlackjackState => proto.initialState(ctx);

// ---- shared test helpers (used by later tasks too) ----
function secret(valueByte: number, saltByte = valueByte): SlotSecret {
  return {
    value: Uint8Array.from([valueByte & 0xff]),
    salt: new Uint8Array(16).fill(saltByte & 0xff),
  };
}
function commitMove(s: SlotSecret): BlackjackMove {
  return { kind: "commit", commitment: computeCommitment(s.value, s.salt), localSecret: s };
}
function revealMove(s: SlotSecret): BlackjackMove {
  return { kind: "reveal", reveal: s };
}
/** Run one full card draw (both commit, both reveal) on an in-progress draw. */
function doDraw(s: BlackjackState, sa: SlotSecret, sb: SlotSecret): BlackjackState {
  s = proto.applyMove(s, commitMove(sa), "A");
  s = proto.applyMove(s, commitMove(sb), "B");
  s = proto.applyMove(s, revealMove(sa), "A");
  s = proto.applyMove(s, revealMove(sb), "B");
  return s;
}
/** Find a secret pair whose derived rank equals `rank` (for deterministic hands). */
function secretsForRank(rank: number): [SlotSecret, SlotSecret] {
  for (let i = 0; i < 1 << 16; i++) {
    const a = secret(i & 0xff, (i >> 4) & 0xff);
    const b = secret((i >> 8) & 0xff, (i >> 12) & 0xff);
    if (deriveRank(a, b) === rank) return [a, b];
  }
  throw new Error(`no secrets found for rank ${rank}`);
}

export { proto, ctx, fresh, secret, commitMove, revealMove, doDraw, secretsForRank };

test("deriveRank is deterministic and within 1..13", () => {
  const a = secret(7), b = secret(42);
  const r1 = deriveRank(a, b);
  const r2 = deriveRank(a, b);
  assert.equal(r1, r2);
  assert.ok(r1 >= 1 && r1 <= 13, `rank ${r1} out of range`);
});

test("deriveRank needs both shares (swapping a share changes the rank space)", () => {
  const ranks = new Set<number>();
  for (let i = 0; i < 200; i++) ranks.add(deriveRank(secret(i), secret(255 - i)));
  // Over many independent pairs we see a healthy spread of ranks, not a constant.
  assert.ok(ranks.size > 5, `expected spread, got ${ranks.size} distinct ranks`);
});

test("initialState begins the opening deal in draw_commit", () => {
  const s = fresh();
  assert.equal(s.phase, "draw_commit");
  assert.equal(s.round, 1n);
  assert.deepEqual(s.draw, { forHand: "player", reason: "deal" });
  assert.equal(s.playerHand.length, 0);
  assert.equal(s.dealerHand.length, 0);
  assert.equal(s.wager, WAGER);
  assert.equal(s.total, 2000n);
  assert.ok(!proto.isTerminal(s));
});

test("initialState is terminal when a round cannot be funded", () => {
  const s = proto.initialState({ tunnelId: "0xab", initialBalances: { a: 50n, b: 1000n } });
  assert.equal(s.phase, "round_over");
  assert.ok(proto.isTerminal(s));
});

test("getPlayerParty / getDealerParty alternate by round", () => {
  assert.equal(getPlayerParty(1n), "A");
  assert.equal(getDealerParty(1n), "B");
  assert.equal(getPlayerParty(3n), "B");
  assert.equal(getDealerParty(3n), "A");
});

test("both commits advance draw_commit -> draw_reveal", () => {
  let s = fresh();
  s = proto.applyMove(s, commitMove(secret(1)), "A");
  assert.equal(s.phase, "draw_commit");
  assert.ok(s.pendingCommitA && !s.pendingCommitB);
  s = proto.applyMove(s, commitMove(secret(2)), "B");
  assert.equal(s.phase, "draw_reveal");
  assert.ok(s.pendingCommitA && s.pendingCommitB);
});

test("a party cannot commit twice for the same card", () => {
  let s = fresh();
  s = proto.applyMove(s, commitMove(secret(1)), "A");
  assert.throws(() => proto.applyMove(s, commitMove(secret(9)), "A"), /already committed/);
});

test("deal from round_over starts the next round", () => {
  // Build a round_over state both can fund.
  const over: BlackjackState = { ...fresh(), phase: "round_over", round: 2n, draw: null };
  const s = proto.applyMove(over, { kind: "deal" }, "A");
  assert.equal(s.phase, "draw_commit");
  assert.equal(s.round, 3n);
  assert.deepEqual(s.draw, { forHand: "player", reason: "deal" });
});

test("non-deal move is rejected in round_over", () => {
  const over: BlackjackState = { ...fresh(), phase: "round_over", round: 2n, draw: null };
  assert.throws(() => proto.applyMove(over, { kind: "hit" }, "A"), /expected 'deal'/);
});
