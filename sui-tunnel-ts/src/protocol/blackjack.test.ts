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
  blackjackHandValue as handValue,
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
  return {
    kind: "commit",
    commitment: computeCommitment(s.value, s.salt),
    localSecret: s,
  };
}
function revealMove(s: SlotSecret): BlackjackMove {
  return { kind: "reveal", reveal: s };
}
/** Run one full card draw (both commit, both reveal) on an in-progress draw. */
function doDraw(
  s: BlackjackState,
  sa: SlotSecret,
  sb: SlotSecret,
): BlackjackState {
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

export {
  proto,
  ctx,
  fresh,
  secret,
  commitMove,
  revealMove,
  doDraw,
  secretsForRank,
};

test("deriveRank is deterministic and within 1..13", () => {
  const a = secret(7),
    b = secret(42);
  const r1 = deriveRank(a, b);
  const r2 = deriveRank(a, b);
  assert.equal(r1, r2);
  assert.ok(r1 >= 1 && r1 <= 13, `rank ${r1} out of range`);
});

test("deriveRank needs both shares (swapping a share changes the rank space)", () => {
  const ranks = new Set<number>();
  for (let i = 0; i < 200; i++)
    ranks.add(deriveRank(secret(i), secret(255 - i)));
  // Over many independent pairs we see a healthy spread of ranks, not a constant.
  assert.ok(
    ranks.size > 5,
    `expected spread, got ${ranks.size} distinct ranks`,
  );
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
  const s = proto.initialState({
    tunnelId: "0xab",
    initialBalances: { a: 50n, b: 1000n },
  });
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
  assert.throws(
    () => proto.applyMove(s, commitMove(secret(9)), "A"),
    /already committed/,
  );
});

test("deal from round_over starts the next round", () => {
  // Build a round_over state both can fund.
  const over: BlackjackState = {
    ...fresh(),
    phase: "round_over",
    round: 2n,
    draw: null,
  };
  const s = proto.applyMove(over, { kind: "deal" }, "A");
  assert.equal(s.phase, "draw_commit");
  assert.equal(s.round, 3n);
  assert.deepEqual(s.draw, { forHand: "player", reason: "deal" });
});

test("non-deal move is rejected in round_over", () => {
  const over: BlackjackState = {
    ...fresh(),
    phase: "round_over",
    round: 2n,
    draw: null,
  };
  assert.throws(
    () => proto.applyMove(over, { kind: "hit" }, "A"),
    /expected 'deal'/,
  );
});

test("a full opening deal lands in player phase with 2+2 cards", () => {
  let s = fresh();
  for (let i = 0; i < 4; i++) {
    assert.equal(
      s.phase,
      "draw_commit",
      `card ${i} should start in draw_commit`,
    );
    s = doDraw(s, secret(i * 2 + 1), secret(i * 2 + 2));
  }
  assert.equal(s.phase, "player");
  assert.equal(s.playerHand.length, 2);
  assert.equal(s.dealerHand.length, 2);
  assert.equal(s.drawCount, 4n);
  assert.equal(s.draw, null);
});

test("a reveal that does not match its commitment is rejected", () => {
  let s = fresh();
  s = proto.applyMove(s, commitMove(secret(1)), "A");
  s = proto.applyMove(s, commitMove(secret(2)), "B");
  assert.equal(s.phase, "draw_reveal");
  // Reveal a DIFFERENT secret than A committed.
  assert.throws(
    () => proto.applyMove(s, revealMove(secret(99)), "A"),
    /does not match commitment/,
  );
});

test("encodeState is stable for the same state", () => {
  let s = fresh();
  s = doDraw(s, secret(1), secret(2));
  assert.equal(toHex(proto.encodeState(s)), toHex(proto.encodeState(s)));
});

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

/** Opening deal with forced cards: player 10+10=20, dealer 5+5=10 (deterministic). */
function dealtToPlayer(): BlackjackState {
  let s = fresh();
  const [ta, tb] = secretsForRank(13); // King -> value 10
  const [fa, fb] = secretsForRank(5); // value 5
  s = doDraw(s, ta, tb); // player card 1 = 10
  s = doDraw(s, ta, tb); // player card 2 = 10  (duplicate rank is fine)
  s = doDraw(s, fa, fb); // dealer card 1 = 5
  s = doDraw(s, fa, fb); // dealer card 2 = 5  -> dealer 10 (< 17)
  return s;
}

test("hit deals one more player card and returns to player phase", () => {
  let s = dealtToPlayer();
  assert.equal(s.phase, "player");
  s = proto.applyMove(s, { kind: "hit" }, "A");
  assert.equal(s.phase, "draw_commit");
  assert.deepEqual(s.draw, { forHand: "player", reason: "hit" });
  // Force the hit card to an Ace (value 11 -> soft, 10+10+11 busts? no: 31 -> aces down -> 21).
  const [aa, ab] = secretsForRank(1);
  s = doDraw(s, aa, ab);
  assert.equal(s.phase, "player"); // 10 + 10 + Ace = 21, not bust
  assert.equal(s.playerHand.length, 3);
});

test("hitting into a bust settles the round to the dealer", () => {
  let s = dealtToPlayer(); // player has 10 + 10 = 20
  s = proto.applyMove(s, { kind: "hit" }, "A");
  const [na, nb] = secretsForRank(5); // value 5 -> 25, bust
  s = doDraw(s, na, nb);
  assert.equal(s.phase, "round_over");
  // Round 1 -> player is A, dealer is B; player busts -> B wins the wager.
  assert.equal(s.balanceB, 1000n + WAGER);
  assert.equal(s.balanceA, 1000n - WAGER);
  assert.equal(s.balanceA + s.balanceB, s.total);
});

test("stand kicks off the dealer auto-draw", () => {
  let s = dealtToPlayer();
  s = proto.applyMove(s, { kind: "stand" }, "A");
  assert.equal(s.phase, "draw_commit");
  assert.deepEqual(s.draw, { forHand: "dealer", reason: "dealer_auto" });
});

test("only the player party may hit", () => {
  const s = dealtToPlayer(); // round 1 -> player is A
  assert.throws(
    () => proto.applyMove(s, { kind: "hit" }, "B"),
    /player's \(A\) turn/,
  );
});

/** From a player-phase state, stand and run dealer auto-draws (all forced to `rank`). */
function standAndResolve(
  s: BlackjackState,
  dealerRank: number,
): BlackjackState {
  s = proto.applyMove(s, { kind: "stand" }, "A");
  const [da, db] = secretsForRank(dealerRank);
  let guard = 0;
  while (s.phase !== "round_over") {
    if (guard++ > 100) throw new Error("dealer loop did not terminate");
    s = doDraw(s, da, db);
  }
  return s;
}

test("dealer draws until reaching at least 17, then settles", () => {
  let s = dealtToPlayer(); // player 20, dealer 10
  s = standAndResolve(s, 5); // dealer 10 -> 15 -> 20, stops at >= 17
  assert.equal(s.phase, "round_over");
  assert.ok(handValue(s.dealerHand) >= 17);
});

test("player 20 beats dealer 19 -> player (A) wins", () => {
  let s = dealtToPlayer(); // player 20, dealer 10
  s = standAndResolve(s, 9); // dealer 10 -> 19, stops; 20 > 19 -> A wins
  assert.equal(s.balanceA, 1000n + WAGER);
  assert.equal(s.balanceB, 1000n - WAGER);
  assert.equal(s.balanceA + s.balanceB, s.total);
});

test("dealer busts -> player (A) wins", () => {
  let s = fresh();
  const [k1, k2] = secretsForRank(13); // value 10
  const [s6a, s6b] = secretsForRank(6); // value 6
  s = doDraw(s, k1, k2); // player 10
  s = doDraw(s, k1, k2); // player 20
  s = doDraw(s, s6a, s6b); // dealer 6
  s = doDraw(s, k1, k2); // dealer 16 (< 17)
  s = standAndResolve(s, 13); // dealer 16 + 10 = 26 -> bust -> A wins
  assert.equal(s.phase, "round_over");
  assert.equal(s.balanceA, 1000n + WAGER);
  assert.equal(s.balanceB, 1000n - WAGER);
});

test("equal final totals push (no transfer)", () => {
  let s = dealtToPlayer(); // player 20, dealer 10
  s = standAndResolve(s, 10); // dealer 10 -> 20, stops; 20 == 20 -> push
  assert.equal(s.phase, "round_over");
  assert.equal(s.balanceA, 1000n);
  assert.equal(s.balanceB, 1000n);
});

test("a dealer already pat (>= 17) draws no card on stand", () => {
  let s = fresh();
  const [k1, k2] = secretsForRank(13); // value 10
  const [n9a, n9b] = secretsForRank(9); // value 9
  s = doDraw(s, k1, k2); // player 10
  s = doDraw(s, k1, k2); // player 20
  s = doDraw(s, k1, k2); // dealer 10
  s = doDraw(s, n9a, n9b); // dealer 19 (>= 17)
  const before = s.drawCount;
  s = proto.applyMove(s, { kind: "stand" }, "A");
  assert.equal(s.phase, "round_over"); // settled immediately, no extra draw
  assert.equal(s.drawCount, before);
  assert.equal(s.balanceA, 1000n + WAGER); // 20 > 19 -> A wins
});

test("handValue handles soft aces", () => {
  assert.equal(handValue([11, 11]), 12); // A + A = 12, not 22
  assert.equal(handValue([11, 10]), 21);
  assert.equal(handValue([11, 5, 10]), 16); // ace downgraded
});

test("a party that committed can forfeit the round when the opponent does not", () => {
  let s = fresh(); // round 1, draw_commit, deal player card
  s = proto.applyMove(s, commitMove(secret(1)), "A"); // A committed, B has not
  s = proto.applyMove(s, { kind: "forfeit" }, "A"); // A claims B's no-show
  assert.equal(s.phase, "round_over");
  assert.equal(s.balanceA, 1000n + WAGER);
  assert.equal(s.balanceB, 1000n - WAGER);
});

test("forfeit is rejected when the opponent does not owe the pending step", () => {
  let s = fresh();
  // Neither has committed -> A has not done its part, cannot claim.
  assert.throws(
    () => proto.applyMove(s, { kind: "forfeit" }, "A"),
    /opponent does not owe/,
  );
});

test("forfeit works in the reveal phase too", () => {
  let s = fresh();
  s = proto.applyMove(s, commitMove(secret(1)), "A");
  s = proto.applyMove(s, commitMove(secret(2)), "B"); // -> draw_reveal
  s = proto.applyMove(s, revealMove(secret(1)), "A"); // A revealed, B has not
  s = proto.applyMove(s, { kind: "forfeit" }, "A");
  assert.equal(s.phase, "round_over");
  assert.equal(s.balanceA, 1000n + WAGER);
});

/** Which party owes the next move in the current phase, or null if none/terminal. */
function owed(s: BlackjackState): "A" | "B" | null {
  if (proto.isTerminal(s)) return null;
  switch (s.phase) {
    case "round_over":
      return getPlayerParty(s.round + 1n);
    case "draw_commit":
      return !s.pendingCommitA ? "A" : !s.pendingCommitB ? "B" : null;
    case "draw_reveal":
      return !s.pendingRevealA ? "A" : !s.pendingRevealB ? "B" : null;
    case "player":
      return getPlayerParty(s.round);
  }
}

test("randomMove drives a full game to a terminal state with conserved balances", () => {
  let s = fresh();
  let rngState = 12345;
  const rng = () => {
    // deterministic LCG so the test is reproducible
    rngState = (1103515245 * rngState + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
  };
  let steps = 0;
  while (!proto.isTerminal(s) && steps < 200000) {
    const by = owed(s);
    if (!by) break;
    const move = proto.randomMove(s, by, rng);
    assert.ok(
      move,
      `randomMove returned null for owed party ${by} in ${s.phase}`,
    );
    s = proto.applyMove(s, move, by);
    steps++;
  }
  assert.ok(proto.isTerminal(s));
  assert.equal(s.balanceA + s.balanceB, s.total);
  assert.ok(s.balanceA >= 0n && s.balanceB >= 0n);
});

test("replaying the same moves yields identical encodeState", () => {
  const moves: Array<{ move: BlackjackMove; by: "A" | "B" }> = [];
  // Record a short scripted hand.
  let s = fresh();
  const record = (move: BlackjackMove, by: "A" | "B") => {
    moves.push({ move, by });
    s = proto.applyMove(s, move, by);
  };
  for (let i = 0; i < 4; i++) {
    record(commitMove(secret(i + 1)), "A");
    record(commitMove(secret(i + 50)), "B");
    record(revealMove(secret(i + 1)), "A");
    record(revealMove(secret(i + 50)), "B");
  }
  const encoded1 = Buffer.from(proto.encodeState(s)).toString("hex");
  // Replay from scratch.
  let r = fresh();
  for (const { move, by } of moves) r = proto.applyMove(r, move, by);
  const encoded2 = Buffer.from(proto.encodeState(r)).toString("hex");
  assert.equal(encoded1, encoded2);
});
