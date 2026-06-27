import assert from "node:assert/strict";
import { test } from "node:test";
import { core } from "sui-tunnel-ts";
import {
  BlackjackBetProtocol,
  commitMoveFromSecret,
  deriveRank,
  MAX_BET,
  maxBet,
  MIN_BET,
  revealMoveFromSecret,
  secureCommitSecret,
  type BetBlackjackMove,
  type BetBlackjackSecret,
  type BetBlackjackState,
} from "./app/lib/bjBetProtocol";

const proto = new BlackjackBetProtocol();
const ctx = { tunnelId: "0xab", initialBalances: { a: 1000n, b: 1000n } };
const fresh = (): BetBlackjackState => proto.initialState(ctx);

function secret(valueByte: number, saltByte = valueByte): BetBlackjackSecret {
  return {
    value: new Uint8Array(16).fill(valueByte & 0xff),
    salt: new Uint8Array(16).fill(saltByte & 0xff),
  };
}
function doDraw(
  s: BetBlackjackState,
  sa: BetBlackjackSecret,
  sb: BetBlackjackSecret,
): BetBlackjackState {
  s = proto.applyMove(s, commitMoveFromSecret(sa), "A");
  s = proto.applyMove(s, commitMoveFromSecret(sb), "B");
  s = proto.applyMove(s, revealMoveFromSecret(sa), "A");
  s = proto.applyMove(s, revealMoveFromSecret(sb), "B");
  return s;
}
function secretsForRank(
  rank: number,
): [BetBlackjackSecret, BetBlackjackSecret] {
  for (let i = 0; i < 1 << 16; i++) {
    const a = secret(i & 0xff, (i >> 4) & 0xff);
    const b = secret((i >> 8) & 0xff, (i >> 12) & 0xff);
    if (deriveRank(a, b) === rank) return [a, b];
  }
  throw new Error(`no secrets found for rank ${rank}`);
}
function startRound(amount = 100): BetBlackjackState {
  return proto.applyMove(fresh(), { action: "bet", amount }, "A");
}

test("deriveRank is deterministic and within 1..13", () => {
  const a = secret(7);
  const b = secret(42);
  assert.equal(deriveRank(a, b), deriveRank(a, b));
  const r = deriveRank(a, b);
  assert.ok(r >= 1 && r <= 13, `rank ${r} out of range`);
});

test("deriveRank depends on BOTH shares (neither can be ignored)", () => {
  const fixedA = new Set<number>();
  for (let i = 0; i < 200; i++) fixedA.add(deriveRank(secret(7), secret(i)));
  assert.ok(fixedA.size > 1, "rank ignores share B");
  const fixedB = new Set<number>();
  for (let i = 0; i < 200; i++) fixedB.add(deriveRank(secret(i), secret(7)));
  assert.ok(fixedB.size > 1, "rank ignores share A");
});

test("cards are NOT predictable from public (round, drawCount): they depend on the secrets", () => {
  // The whole point of v2: the same draw position yields different ranks for different secret
  // pairs, so neither seat can precompute the shoe from the public round/draw counters.
  const ranks = new Set<number>();
  for (let i = 1; i < 64; i++) ranks.add(deriveRank(secret(i), secret(i + 1)));
  assert.ok(
    ranks.size > 5,
    `deck looks deterministic: only ${ranks.size} ranks`,
  );
});

test("secureCommitSecret yields a 16-byte CSPRNG value+salt that verifies", () => {
  const s = secureCommitSecret();
  assert.equal(s.value.length, 16);
  assert.equal(s.salt.length, core.MIN_SALT_LEN);
  const c = core.computeCommitment(s.value, s.salt);
  assert.ok(core.verifyCommitment(c, s.value, s.salt));
});

test("bet starts the opening deal in draw_commit", () => {
  const s = startRound();
  assert.equal(s.phase, "draw_commit");
  assert.equal(s.round, 1n);
  assert.deepEqual(s.draw, { forHand: "player", reason: "deal" });
  assert.equal(s.bet, 100n);
});

test("maxBet is capped at MAX_BET and bets above it are rejected (anti-stall invariant)", () => {
  // Large balances: affordable is huge, but the per-round stake must not exceed MAX_BET (= the
  // on-chain force-close penalty), so stalling to dodge a loss can never out-earn the forfeit.
  const big: BetBlackjackState = {
    ...fresh(),
    balanceA: 1_000_000n,
    balanceB: 1_000_000n,
  };
  assert.equal(proto.actorFor(big), "A");
  assert.equal(maxBet(big), MAX_BET);
  assert.throws(
    () =>
      proto.applyMove(big, { action: "bet", amount: Number(MAX_BET) + 1 }, "A"),
    /bet must be/,
  );
  // Exactly MAX_BET is allowed.
  const s = proto.applyMove(
    big,
    { action: "bet", amount: Number(MAX_BET) },
    "A",
  );
  assert.equal(s.bet, MAX_BET);
});

test("only the round's player may set the bet", () => {
  assert.throws(
    () => proto.applyMove(fresh(), { action: "bet", amount: 100 }, "B"),
    /only the player/,
  );
});

test("opening deal lands in player phase with 2 player + 1 dealer up-card (hole card deferred)", () => {
  let s = startRound();
  for (let i = 0; i < 3; i++) {
    assert.equal(s.phase, "draw_commit", `card ${i} should be in draw_commit`);
    s = doDraw(s, secret(i * 2 + 1), secret(i * 2 + 2));
  }
  assert.equal(s.phase, "player");
  assert.equal(s.playerHand.length, 2);
  // Only the dealer up-card is dealt; the hole card is drawn after the player stands so the
  // player never holds it in state while deciding.
  assert.equal(s.dealerHand.length, 1);
  assert.equal(s.drawCount, 3n);
});

test("both commits advance draw_commit -> draw_reveal; double-commit rejected", () => {
  let s = startRound();
  s = proto.applyMove(s, commitMoveFromSecret(secret(1)), "A");
  assert.equal(s.phase, "draw_commit");
  assert.throws(
    () => proto.applyMove(s, commitMoveFromSecret(secret(9)), "A"),
    /already committed/,
  );
  s = proto.applyMove(s, commitMoveFromSecret(secret(2)), "B");
  assert.equal(s.phase, "draw_reveal");
});

test("a reveal that does not match its commitment is rejected", () => {
  let s = startRound();
  s = proto.applyMove(s, commitMoveFromSecret(secret(1)), "A");
  s = proto.applyMove(s, commitMoveFromSecret(secret(2)), "B");
  assert.throws(
    () => proto.applyMove(s, revealMoveFromSecret(secret(99)), "A"),
    /does not match commitment/,
  );
});

/** Opening deal with forced cards: player 10+10=20, dealer up-card 5 (hole card drawn on stand). */
function dealtToPlayer(amount = 100): BetBlackjackState {
  let s = startRound(amount);
  const [ta, tb] = secretsForRank(13); // value 10
  const [fa, fb] = secretsForRank(5);
  s = doDraw(s, ta, tb); // player 10
  s = doDraw(s, ta, tb); // player 20
  s = doDraw(s, fa, fb); // dealer up-card 5 -> player phase
  return s;
}

test("hitting into a bust settles to the dealer; variable bet is swung", () => {
  let s = dealtToPlayer(250); // player 20
  s = proto.applyMove(s, { action: "hit" }, "A");
  const [na, nb] = secretsForRank(5); // -> 25 bust
  s = doDraw(s, na, nb);
  assert.equal(s.phase, "round_over");
  assert.equal(s.balanceB, 1000n + 250n); // dealer B wins the 250 bet
  assert.equal(s.balanceA, 1000n - 250n);
  assert.equal(s.balanceA + s.balanceB, s.total);
});

test("player 20 beats the dealer -> player A wins the bet", () => {
  let s = dealtToPlayer(300); // player 20, dealer up-card 5
  s = proto.applyMove(s, { action: "stand" }, "A");
  // Dealer draws its hole card + to 17 from the up-card 5: 5 -> 11 -> 17 (stands), 17 < 20.
  const [da, db] = secretsForRank(6); // value 6
  let guard = 0;
  while (s.phase !== "round_over") {
    if (guard++ > 50) throw new Error("dealer loop stuck");
    s = doDraw(s, da, db);
  }
  // Dealer drew its hole card (deferred from the deal) plus at least one more to reach 17.
  assert.ok(
    s.dealerHand.length >= 2,
    "dealer should have drawn the hole card + to 17",
  );
  assert.equal(s.balanceA, 1000n + 300n);
  assert.equal(s.balanceB, 1000n - 300n);
});

test("forfeit: a committed party claims the round when the opponent stalls (M1)", () => {
  let s = startRound(100);
  s = proto.applyMove(s, commitMoveFromSecret(secret(1)), "A"); // A committed, B has not
  s = proto.applyMove(s, { action: "forfeit" }, "A");
  assert.equal(s.phase, "round_over");
  assert.equal(s.balanceA, 1000n + 100n);
  assert.equal(s.balanceB, 1000n - 100n);
});

test("applyCommit preserves a restored secret when the relayed (stripped) move carries none", () => {
  // Cold-load resume re-seats a commit whose localSecret was stripped by the relay codec, with the
  // seat's secret restored onto the state. applyCommit must keep that secret, not null it, or the
  // resumed seat could never reveal.
  let s = startRound();
  const restored = secret(7);
  s = { ...s, localSecretA: restored };
  const stripped: BetBlackjackMove = {
    action: "commit",
    commitment: core.computeCommitment(restored.value, restored.salt),
  };
  s = proto.applyMove(s, stripped, "A");
  assert.deepEqual(s.localSecretA, restored);
});

test("forfeit is rejected when the opponent does not owe the pending step", () => {
  const s = startRound(100); // neither committed -> claimant has not done its part
  assert.throws(
    () => proto.applyMove(s, { action: "forfeit" }, "A"),
    /opponent does not owe/,
  );
});

test("encodeState excludes localSecret (secret cannot leak via the signed hash)", () => {
  let s = startRound();
  s = proto.applyMove(s, commitMoveFromSecret(secret(1)), "A");
  const withSecret = s;
  const withoutSecret: BetBlackjackState = { ...s, localSecretA: null };
  assert.equal(
    Buffer.from(proto.encodeState(withSecret)).toString("hex"),
    Buffer.from(proto.encodeState(withoutSecret)).toString("hex"),
  );
});

test("encodeState distinguishes states differing in a single public field", () => {
  const base = startRound();
  const enc = (s: BetBlackjackState) =>
    Buffer.from(proto.encodeState(s)).toString("hex");
  assert.notEqual(enc(base), enc({ ...base, drawCount: base.drawCount + 1n }));
  assert.notEqual(enc(base), enc({ ...base, bet: base.bet + 1n }));
  assert.notEqual(
    enc(base),
    enc({ ...base, pendingCommitA: new Uint8Array(32).fill(1) }),
  );
});

/** Which seat owes the next move (drives the test loop). */
function owed(s: BetBlackjackState): "A" | "B" | null {
  if (proto.isTerminal(s)) return null;
  if (proto.pendingActionFor(s, "A")) return "A";
  if (proto.pendingActionFor(s, "B")) return "B";
  return null;
}

test("randomMove drives a full game to terminal with conserved balances", () => {
  let s = fresh();
  let st = 12345;
  const rng = () => {
    st = (1103515245 * st + 12345) & 0x7fffffff;
    return st / 0x7fffffff;
  };
  let steps = 0;
  while (!proto.isTerminal(s) && steps < 500000) {
    const by = owed(s);
    if (!by) break;
    const mv = proto.randomMove(s, by, rng);
    assert.ok(mv, `randomMove null for owed ${by} in ${s.phase}`);
    s = proto.applyMove(s, mv as BetBlackjackMove, by);
    steps++;
  }
  assert.ok(proto.isTerminal(s));
  assert.equal(s.balanceA + s.balanceB, s.total);
  assert.ok(s.balanceA >= 0n && s.balanceB >= 0n);
});

test("isTerminal once the table cannot fund the minimum bet", () => {
  const s: BetBlackjackState = {
    ...fresh(),
    balanceA: MIN_BET - 1n,
    balanceB: 2000n - (MIN_BET - 1n),
  };
  assert.ok(proto.isTerminal(s));
});
