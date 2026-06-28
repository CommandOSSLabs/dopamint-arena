// Added on feat/blackjack-cr-ui (PR #102) — the branch that ships the commit-reveal
// Blackjack UI. (Deliberately NOT on dev-raid, whose PvP still runs the deterministic
// bjBetProtocol that #102 deletes.) Fills the gaps the existing blackjack.test.ts
// leaves against Kostas's randomness rules. The existing suite already covers
// deriveRank-depends-on-both-shares (unbias), reveal-must-match-commitment (binding),
// forfeit-when-opponent-owes, and conservation. Added here as GREEN regression guards
// — invariants the commit-reveal protocol genuinely SATISFIES:
//
//   1. encodeState EXCLUDES each seat's local commit secret — the property that lets a
//      card stay hidden while both seats still co-sign the SAME state hash.
//   2. The last revealer, who can already compute the card, is BOUND to its commitment:
//      it may only reveal the predetermined value or ABORT — and an abort is punished
//      (the honest seat claims the forfeit). Unbiasable + abort-resistant, per Kostas.
//
// NOTE (not tested here): the protocol's forfeit is intentionally scoped to the
// commit-reveal draw phases; a player who stalls at the hit/stand DECISION is not
// punishable in-protocol — that case is deferred to the tunnel's penalty_amount on
// force_close. That backstop is a tunnel/app-level concern (it only holds if penalty ≥
// stake AND the dispute path actually fires); it is reviewed separately in
// docs/design/game-channel-close-safety.md (findings F1/F1b/F1c) and its red spec lives
// in sui-tunnel-ts/src/protocol/ticTacToe.abandonment.test.ts. So it is not duplicated
// as a BJ-protocol test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCommitment } from "../core/commitment";
import {
  BlackjackMove,
  BlackjackProtocol,
  BlackjackSlotSecret,
  BlackjackState,
  deriveRank,
} from "./blackjack";

const proto = new BlackjackProtocol();
const ctx = { tunnelId: "0xab", initialBalances: { a: 1000n, b: 1000n } };
const BET = 100n;

function secret(valueByte: number, saltByte = valueByte): BlackjackSlotSecret {
  return {
    value: Uint8Array.from([valueByte & 0xff]),
    salt: new Uint8Array(16).fill(saltByte & 0xff),
  };
}
const commitMove = (s: BlackjackSlotSecret): BlackjackMove => ({
  kind: "commit",
  commitment: computeCommitment(s.value, s.salt),
  localSecret: s,
});
const revealMove = (s: BlackjackSlotSecret): BlackjackMove => ({
  kind: "reveal",
  reveal: s,
});
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Place the opening bet so round 1 begins (player A bets) → first card's draw_commit. */
function openedToDrawCommit(): BlackjackState {
  const s0 = proto.initialState(ctx); // round_over, round 0
  return proto.applyMove(s0, { kind: "bet", amount: BET }, "A");
}

test("encodeState excludes BOTH seats' local commit secrets (the secret never enters the co-signed hash)", () => {
  let s = openedToDrawCommit();
  s = proto.applyMove(s, commitMove(secret(1)), "A");
  s = proto.applyMove(s, commitMove(secret(2)), "B"); // both committed -> draw_reveal
  const baseline = hex(proto.encodeState(s));

  // Each seat holds its OWN secret, not the other's. For both to co-sign the SAME hash,
  // encodeState must depend on neither localSecret. Vary each, then both → identical.
  assert.equal(hex(proto.encodeState({ ...s, localSecretA: secret(123, 200) })), baseline, "localSecretA leaked");
  assert.equal(hex(proto.encodeState({ ...s, localSecretB: secret(231, 17) })), baseline, "localSecretB leaked");
  assert.equal(
    hex(proto.encodeState({ ...s, localSecretA: secret(9, 9), localSecretB: secret(250, 4) })),
    baseline,
    "local secrets leaked",
  );

  // Discrimination: the PUBLIC commitment IS hashed, so a different committed value DOES
  // change the encoding — encodeState isn't just ignoring everything.
  assert.notEqual(
    hex(proto.encodeState({ ...s, pendingCommitA: computeCommitment(secret(1).value, new Uint8Array(16).fill(5)) })),
    baseline,
  );
});

test("the last revealer is bound to its commitment: reveal the predetermined card or abort (and an abort is penalized)", () => {
  const sa = secret(1);
  const sb = secret(2);
  let s = openedToDrawCommit();
  s = proto.applyMove(s, commitMove(sa), "A");
  s = proto.applyMove(s, commitMove(sb), "B"); // -> draw_reveal
  s = proto.applyMove(s, revealMove(sa), "A"); // A reveals first; B is the LAST revealer

  // B already knows the card (A's public reveal + B's own secret) before revealing.
  const predetermined = deriveRank(sa, sb);
  assert.ok(predetermined >= 1 && predetermined <= 13);

  // (a) B dislikes it and tries to substitute a different value: rejected (binding) — no bias.
  assert.throws(
    () => proto.applyMove(s, revealMove(secret(77)), "B"),
    /does not match commitment/,
    "last revealer must not be able to swap its committed value",
  );
  // (b) B's only valid reveal is its committed secret, which completes the draw deterministically.
  assert.notEqual(proto.applyMove(s, revealMove(sb), "B").phase, "draw_reveal");
  // (c) B's only escape is to ABORT — not free: A (who did its half) claims the forfeit.
  const forfeited = proto.applyMove(s, { kind: "forfeit" }, "A");
  assert.equal(forfeited.phase, "round_over");
  assert.equal(forfeited.balanceA, 1000n + BET, "aborting the reveal forfeits the bet to the honest seat");
});
