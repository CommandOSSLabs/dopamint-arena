import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BlackjackProtocol,
  BlackjackState,
  WAGER,
  ROUND_CAP,
} from "./blackjack";
import { toHex } from "../core/bytes";
import { OffchainTunnel, verifyCoSignedUpdate } from "../core/tunnel";
import { generateKeyPair, ed25519Address } from "../core/crypto";
import { Party } from "./Protocol";

const proto = new BlackjackProtocol();
const ctx = { tunnelId: "0xab", initialBalances: { a: 1000n, b: 1000n } };

function fresh(): BlackjackState {
  return proto.initialState(ctx);
}

test("initialState deals the opening round and conserves balances", () => {
  const s = fresh();
  assert.equal(s.phase, "player");
  assert.equal(s.round, 1n);
  assert.equal(s.playerHand.length, 2);
  assert.equal(s.dealerHand.length, 2);
  assert.equal(s.drawIndex, 4n);
  assert.equal(s.wager, WAGER);
  assert.equal(s.balanceA, 1000n);
  assert.equal(s.balanceB, 1000n);
  assert.equal(s.total, 2000n);
  assert.ok(!proto.isTerminal(s));
});

test("initialState is already terminal when a round cannot be funded", () => {
  const s = proto.initialState({
    tunnelId: "0xab",
    initialBalances: { a: 50n, b: 1000n },
  });
  assert.equal(s.phase, "round_over");
  assert.equal(s.round, 0n);
  assert.ok(proto.isTerminal(s));
});

test("a full round settles, conserves the total, and ends in round_over", () => {
  let s = fresh();
  // Player stands immediately, dealer auto-plays and the round settles.
  s = proto.applyMove(s, { action: "stand" }, "A");
  assert.equal(s.phase, "dealer");
  s = proto.applyMove(s, { action: "stand" }, "B");
  assert.equal(s.phase, "round_over");
  const bal = proto.balances(s);
  assert.equal(bal.a + bal.b, 2000n);
  // Settlement moved at most one wager between the parties.
  assert.ok(bal.a === 1000n || bal.a === 900n || bal.a === 1100n);
});

test("player hitting eventually busts or stands without breaking conservation", () => {
  let s = fresh();
  // Keep hitting until the round resolves (bust) or we hit the dealer phase.
  for (let i = 0; i < 30 && s.phase === "player"; i++) {
    s = proto.applyMove(s, { action: "hit" }, "A");
  }
  const bal = proto.balances(s);
  assert.equal(bal.a + bal.b, 2000n);
  assert.ok(bal.a >= 0n && bal.b >= 0n);
});

test("applyMove rejects wrong-turn and illegal dealer hit", () => {
  let s = fresh();
  // Player's turn: dealer (B) cannot move.
  assert.throws(() => proto.applyMove(s, { action: "hit" }, "B"));
  s = proto.applyMove(s, { action: "stand" }, "A"); // -> dealer phase
  // Dealer's turn: player (A) cannot move.
  assert.throws(() => proto.applyMove(s, { action: "stand" }, "A"));
  // Dealer may not 'hit' (auto-play only).
  assert.throws(() => proto.applyMove(s, { action: "hit" }, "B"));
});

test("applyMove rejects unknown actions", () => {
  const s = fresh();
  assert.throws(() =>
    proto.applyMove(s, { action: "fold" } as unknown as { action: "hit" }, "A"),
  );
});

test("round_over deals a fresh round on any move (incrementing round)", () => {
  let s = fresh();
  s = proto.applyMove(s, { action: "stand" }, "A");
  s = proto.applyMove(s, { action: "stand" }, "B");
  assert.equal(s.phase, "round_over");
  const prevRound = s.round;
  s = proto.applyMove(s, { action: "hit" }, "A");
  assert.equal(s.phase, "player");
  assert.equal(s.round, prevRound + 1n);
  assert.equal(s.playerHand.length, 2);
  assert.equal(s.dealerHand.length, 2);
});

test("applyMove is pure (does not mutate input state or its hands)", () => {
  const s = fresh();
  const beforeHand = [...s.playerHand];
  const beforeDraw = s.drawIndex;
  proto.applyMove(s, { action: "hit" }, "A");
  assert.deepEqual(s.playerHand, beforeHand);
  assert.equal(s.drawIndex, beforeDraw);
  assert.equal(s.phase, "player");
});

test("encodeState is deterministic and changes with state", () => {
  const s0 = fresh();
  const s1 = proto.applyMove(s0, { action: "hit" }, "A");
  assert.equal(toHex(proto.encodeState(s0)), toHex(proto.encodeState(s0)));
  assert.notEqual(toHex(proto.encodeState(s0)), toHex(proto.encodeState(s1)));
});

test("encodeState distinguishes states with the same balances but different hands", () => {
  // Two different tunnels produce different deterministic deals -> different hands.
  const sX = proto.initialState({
    tunnelId: "0x01",
    initialBalances: { a: 1000n, b: 1000n },
  });
  const sY = proto.initialState({
    tunnelId: "0x02",
    initialBalances: { a: 1000n, b: 1000n },
  });
  // Balances are identical; encodings must still differ because hands differ
  // (or, if hands coincidentally match, that's still a valid canonical encoding).
  if (
    JSON.stringify(sX.playerHand) !== JSON.stringify(sY.playerHand) ||
    JSON.stringify(sX.dealerHand) !== JSON.stringify(sY.dealerHand)
  ) {
    assert.notEqual(toHex(proto.encodeState(sX)), toHex(proto.encodeState(sY)));
  }
});

test("balances always sum to total across a long random self-play sequence", () => {
  let s = fresh();
  let x = 0.123456789;
  const rng = () => (x = (x * 16807) % 1) || 0.5;
  for (let i = 0; i < 5000; i++) {
    if (proto.isTerminal(s)) break;
    // Whoever has the move plays; try both, the engine ignores the null one.
    const order: Party[] = s.phase === "dealer" ? ["B", "A"] : ["A", "B"];
    let moved = false;
    for (const by of order) {
      const m = proto.randomMove(s, by, rng);
      if (!m) continue;
      s = proto.applyMove(s, m, by);
      moved = true;
      break;
    }
    assert.ok(moved, "someone must have a legal move when not terminal");
    const bal = proto.balances(s);
    assert.equal(bal.a + bal.b, 2000n);
    assert.ok(bal.a >= 0n && bal.b >= 0n);
  }
});

test("randomMove returns null when it is not the party's turn and when terminal", () => {
  const s = fresh(); // player phase
  const rng = () => 0.5;
  assert.equal(proto.randomMove(s, "B", rng), null); // not dealer's turn
  assert.ok(proto.randomMove(s, "A", rng)); // player has a move

  const term = proto.initialState({
    tunnelId: "0xab",
    initialBalances: { a: 10n, b: 10n },
  });
  assert.ok(proto.isTerminal(term));
  assert.equal(proto.randomMove(term, "A", rng), null);
  assert.equal(proto.randomMove(term, "B", rng), null);
});

test("randomMove only ever yields legal moves over many transitions", () => {
  let s = fresh();
  let x = 0.987654321;
  const rng = () => (x = (x * 48271) % 1) || 0.5;
  for (let i = 0; i < 3000; i++) {
    if (proto.isTerminal(s)) break;
    const by: Party = s.phase === "dealer" ? "B" : "A";
    const m = proto.randomMove(s, by, rng);
    if (!m) {
      // The only non-mover should be the off-turn party; the on-turn party always moves.
      assert.fail("on-turn party returned a null move");
    }
    // Must not throw — i.e. the move is legal.
    s = proto.applyMove(s, m, by);
  }
});

test("isTerminal becomes true once a party can no longer cover the wager", () => {
  // Construct a near-broke state by reaching into balances after a settled round.
  let s = fresh();
  s = proto.applyMove(s, { action: "stand" }, "A");
  s = proto.applyMove(s, { action: "stand" }, "B");
  assert.equal(s.phase, "round_over");
  const broke: BlackjackState = {
    ...s,
    balanceA: 50n,
    balanceB: s.balanceA + s.balanceB - 50n,
  };
  assert.ok(proto.isTerminal(broke));
  assert.throws(() => proto.applyMove(broke, { action: "hit" }, "A"));
});

test("ROUND_CAP forces terminality", () => {
  const s = fresh();
  const capped: BlackjackState = {
    ...s,
    phase: "round_over",
    round: ROUND_CAP,
  };
  assert.ok(proto.isTerminal(capped));
});

test("end-to-end self-play tunnel: latest co-signed update verifies", () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const t = OffchainTunnel.selfPlay(
    new BlackjackProtocol(),
    "0x" + "33".repeat(32),
    a,
    b,
    ed25519Address(a.publicKey),
    ed25519Address(b.publicKey),
    { a: 1000n, b: 1000n },
  );

  // Play several rounds: player stands, dealer stands, then deal again.
  for (let r = 0; r < 5; r++) {
    if (proto.isTerminal(t.state)) break;
    if (t.state.phase === "round_over") {
      t.step({ action: "hit" }, "A"); // deal a new round
    }
    if (t.state.phase === "player") {
      t.step({ action: "stand" }, "A");
    }
    if (t.state.phase === "dealer") {
      t.step({ action: "stand" }, "B");
    }
  }

  assert.ok(t.latest, "expected at least one co-signed update");
  assert.ok(
    verifyCoSignedUpdate(
      t.latest!,
      { publicKey: t.partyA.publicKey, scheme: t.partyA.scheme },
      { publicKey: t.partyB.publicKey, scheme: t.partyB.scheme },
    ),
  );
  const bal = proto.balances(t.state);
  assert.equal(bal.a + bal.b, 2000n);
});
