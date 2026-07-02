// Channel-close safety review (SolEng) — Quantum Poker.
//
// The existing quantumPoker.test.ts already proves the GOOD properties (commit-reveal
// binding, holes excluded from encodeState, balance conservation, all-in clamping).
// This file fills the one gap those leave: Kostas's invariant 3 — "you lose your money
// if you don't progress" — at the showdown reveal.
//
// Quantum Poker is the ONLY game with a game-aware on-chain referee
// (quantum_poker_referee.move `resolve_dispute_verified`, a Groth16 re-derivation of the
// payout). But that referee is DEAD CODE: it is never invoked from frontend/ or backend/,
// and the prover is a stub that throws ("trusted setup required",
// zk/quantumPokerResultCircuit.ts `UnavailableQuantumPokerResultProver`). The poker PvP
// open also passes NO penalty (penaltyAmount defaults to 0n; constants.ts POKER_BUYIN with
// no penalty constant). So in production poker settles exactly like every other game:
// cooperative close, or a GAME-BLIND `force_close_after_timeout` that pays the latest
// co-signed balances + a flat penalty of ZERO.
//
// Consequence (proven below): at showdown both seats must reveal their own holes, and the
// `settle` that moves the pot fires ONLY when both have revealed. Bets are escrowed in
// `totalBet*`; balances stay EVEN until that moment. So the LAST revealer — who can already
// see it has lost — withholds its reveal. The honest winner is stranded on an even state,
// and the game-blind, penalty-0 close pays it out. The winner never collects the pot it won.
//
// The on-chain consequence (penalty-0 force_close pays the even state) is proven generically
// in sui_tunnel/tests/game_close_safety_tests.move; the engine's "no advance without an ACK"
// is proven in ticTacToe.abandonment.test.ts. Here we prove the poker-specific money-flow
// fact that makes both apply: the settling move belongs to the losing seat.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Party } from "./Protocol";
import {
  commitSlotSecrets,
  expectedQuantumPokerRevealSlots,
  PokerMove,
  PokerState,
  QuantumPokerProtocol,
  SlotSecret,
} from "./quantumPoker";

const START = 1000n;
const HOLE: Record<Party, readonly number[]> = { A: [0, 1], B: [2, 3] };

// Deterministic per-slot secrets (same shape as quantumPoker.test.ts): 32-byte value,
// 16-byte salt (>= MIN_SALT_LEN), varied by `base` so each hand is distinct.
function secrets(base: number): SlotSecret[] {
  return Array.from({ length: 9 }, (_, slot) => ({
    value: Uint8Array.from({ length: 32 }, (_, i) => (base + slot + i) & 0xff),
    salt: Uint8Array.from({ length: 16 }, (_, i) => (base * 3 + slot + i) & 0xff),
  }));
}

function reveal(s: SlotSecret[], slots: readonly number[]): PokerMove {
  return { kind: "reveal_slots", slots: [...slots], reveals: slots.map((i) => s[i]) };
}

const bal = (s: PokerState, w: Party): bigint => (w === "A" ? s.balanceA : s.balanceB);

/**
 * Play a full hand to the showdown phase with a genuinely contested pot (antes + a preflop
 * bet/call), with NEITHER seat's holes revealed yet. Card values are real (derived from the
 * combined reveals) — nothing here forces an outcome.
 */
function playToShowdown(
  p: QuantumPokerProtocol,
  a: SlotSecret[],
  b: SlotSecret[],
): PokerState {
  let s = p.initialState({ tunnelId: "0xpoker", initialBalances: { a: START, b: START } });
  s = p.applyMove(s, { kind: "commit_slots", commitments: commitSlotSecrets(a), localSecrets: a }, "A");
  s = p.applyMove(s, { kind: "commit_slots", commitments: commitSlotSecrets(b), localSecrets: b }, "B");
  // open_private_holes: each seat reveals the OTHER seat's hole shares.
  s = p.applyMove(s, reveal(a, [2, 3]), "A");
  s = p.applyMove(s, reveal(b, [0, 1]), "B");
  // preflop_bet: build a real pot — A bets 100, B calls.
  s = p.applyMove(s, { kind: "bet", amount: 100n }, "A");
  s = p.applyMove(s, { kind: "call" }, "B");
  // run the board out, checking every street.
  s = p.applyMove(s, reveal(a, [4, 5, 6]), "A");
  s = p.applyMove(s, reveal(b, [4, 5, 6]), "B");
  s = p.applyMove(s, { kind: "check" }, "A");
  s = p.applyMove(s, { kind: "check" }, "B");
  s = p.applyMove(s, reveal(a, [7]), "A");
  s = p.applyMove(s, reveal(b, [7]), "B");
  s = p.applyMove(s, { kind: "check" }, "A");
  s = p.applyMove(s, { kind: "check" }, "B");
  s = p.applyMove(s, reveal(a, [8]), "A");
  s = p.applyMove(s, reveal(b, [8]), "B");
  s = p.applyMove(s, { kind: "check" }, "A");
  s = p.applyMove(s, { kind: "check" }, "B");
  if (s.phase !== "showdown") throw new Error(`expected showdown, got ${s.phase}`);
  return s;
}

/** Find a deterministic hand whose showdown has a decisive winner (most hands are). */
function decisiveShowdown(): {
  p: QuantumPokerProtocol;
  a: SlotSecret[];
  b: SlotSecret[];
  sd: PokerState;
  winner: Party;
} {
  for (let k = 0; k < 60; k++) {
    const p = new QuantumPokerProtocol();
    const a = secrets(1 + 2 * k);
    const b = secrets(2 + 2 * k);
    const sd = playToShowdown(p, a, b);
    let probe = p.applyMove(sd, reveal(a, HOLE.A), "A");
    probe = p.applyMove(probe, reveal(b, HOLE.B), "B");
    if (probe.winner === "A" || probe.winner === "B") {
      return { p, a, b, sd, winner: probe.winner };
    }
  }
  throw new Error("no decisive (non-tie) showdown sampled in 60 deterministic hands");
}

const secretsOf = (
  a: SlotSecret[],
  b: SlotSecret[],
  who: Party,
): SlotSecret[] => (who === "A" ? a : b);

// GREEN — the real mechanism: the pot is escrowed in totalBet (balances stay EVEN), and the
// ONLY move that settles it is the LAST revealer's. This documents that the setup below is
// genuine, not contrived: the losing seat is the one holding the settling signature.
test("at showdown the pot is escrowed (balances even) and only the LAST revealer settles it", () => {
  const { p, a, b, sd, winner } = decisiveShowdown();
  const loser: Party = winner === "A" ? "B" : "A";

  // Pot is contested but UNSETTLED: balances are still even; the money lives in totalBet.
  assert.equal(sd.balanceA, START);
  assert.equal(sd.balanceB, START);
  assert.equal(sd.totalBetA, sd.totalBetB);
  assert.ok(sd.totalBetA >= 150n, "antes (50) + preflop bet (100) are escrowed");

  // The honest winner does its half — reveals its own holes. The pot STILL has not moved.
  const sWin = p.applyMove(sd, reveal(secretsOf(a, b, winner), HOLE[winner]), winner);
  assert.equal(sWin.phase, "showdown");
  assert.equal(bal(sWin, winner), START);

  // Now only the LOSING seat can advance the game, and doing so pays the winner.
  assert.deepEqual(expectedQuantumPokerRevealSlots(sWin, winner), []);
  assert.deepEqual(expectedQuantumPokerRevealSlots(sWin, loser), [...HOLE[loser]]);
  const settled = p.applyMove(sWin, reveal(secretsOf(a, b, loser), HOLE[loser]), loser);
  assert.equal(settled.winner, winner);
  assert.ok(bal(settled, winner) > START, "the loser's reveal would settle the winner's pot");
});

// RED — the gap (this test FAILS today; that is the point — it must show up in CI).
test("SECURITY (F1): an honest showdown winner can finalize its won pot WITHOUT the loser's reveal", () => {
  const { p, a, b, sd, winner } = decisiveShowdown();

  // The winner reveals its holes — everything required of it. The losing last-revealer,
  // seeing it will lose, withholds its reveal; the hand freezes at EVEN balances.
  const sWin = p.applyMove(sd, reveal(secretsOf(a, b, winner), HOLE[winner]), winner);
  assert.equal(sWin.phase, "showdown");

  // The winner has no further move — the chain proves EVEN is its ceiling: it owes no slot,
  // and re-revealing is rejected. So this is the best state it can co-sign / force_close on.
  assert.deepEqual(expectedQuantumPokerRevealSlots(sWin, winner), []);
  assert.throws(
    () => p.applyMove(sWin, reveal(secretsOf(a, b, winner), HOLE[winner]), winner),
    /already revealed|expected/,
  );

  // Poker opens with penaltyAmount = 0 and its ZK referee is never wired, so the game-blind
  // force_close pays exactly these EVEN balances. Assert the SAFE outcome we WANT — it fails.
  assert.ok(
    bal(sWin, winner) > START,
    "an honest showdown winner must be able to claim the pot it won when the losing " +
      "last-revealer withholds — today it settles EVEN (penalty=0, ZK referee unwired)",
  );
});
