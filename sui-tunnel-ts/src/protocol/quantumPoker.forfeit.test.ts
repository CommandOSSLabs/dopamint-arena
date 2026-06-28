// Forfeit-claim fix for the F1 abandonment gap (mirrors blackjack `claimForfeit`):
// at a reveal phase, the seat that has done its part can claim the contested pot when the
// opponent withholds the reveal it owes. Withholding is treated as an implicit fold.

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

function playToShowdown(
  p: QuantumPokerProtocol,
  a: SlotSecret[],
  b: SlotSecret[],
): PokerState {
  let s = p.initialState({ tunnelId: "0xpoker", initialBalances: { a: START, b: START } });
  s = p.applyMove(s, { kind: "commit_slots", commitments: commitSlotSecrets(a), localSecrets: a }, "A");
  s = p.applyMove(s, { kind: "commit_slots", commitments: commitSlotSecrets(b), localSecrets: b }, "B");
  s = p.applyMove(s, reveal(a, [2, 3]), "A");
  s = p.applyMove(s, reveal(b, [0, 1]), "B");
  s = p.applyMove(s, { kind: "bet", amount: 100n }, "A");
  s = p.applyMove(s, { kind: "call" }, "B");
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

const secretsOf = (a: SlotSecret[], b: SlotSecret[], who: Party): SlotSecret[] =>
  who === "A" ? a : b;

// GREEN (the fix): the honest winner reveals its holes, the loser withholds, and the winner
// claims the pot it won via a `forfeit` move — without the loser's reveal.
test("forfeit: an honest revealer claims the contested pot when the opponent withholds at showdown", () => {
  const { p, a, b, sd, winner } = decisiveShowdown();
  const loser: Party = winner === "A" ? "B" : "A";

  const sWin = p.applyMove(sd, reveal(secretsOf(a, b, winner), HOLE[winner]), winner);
  assert.equal(sWin.phase, "showdown");
  assert.equal(bal(sWin, winner), START);
  assert.deepEqual(expectedQuantumPokerRevealSlots(sWin, winner), []);
  assert.deepEqual(expectedQuantumPokerRevealSlots(sWin, loser), [...HOLE[loser]]);

  // The honest winner claims the abandoned pot.
  const claimed = p.applyMove(sWin, { kind: "forfeit" } as PokerMove, winner);
  assert.equal(claimed.phase, "hand_over");
  assert.equal(claimed.winner, winner);
  assert.ok(bal(claimed, winner) > START, "winner must collect the pot it won");
  assert.equal(bal(claimed, loser), START - (bal(claimed, winner) - START), "loser pays the pot");
});

// A seat that still owes its own reveal cannot forfeit (it hasn't done its part).
test("forfeit: a seat that still owes a reveal cannot claim a forfeit", () => {
  const { p, sd, winner } = decisiveShowdown();
  const loser: Party = winner === "A" ? "B" : "A";
  // At raw showdown both owe their holes; neither may forfeit.
  assert.throws(() => p.applyMove(sd, { kind: "forfeit" } as PokerMove, winner), /forfeit/);
  assert.throws(() => p.applyMove(sd, { kind: "forfeit" } as PokerMove, loser), /forfeit/);
});
