import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32 } from "../sim/rng";
import type { Party } from "./Protocol";
import { QuantumPokerProtocol } from "./quantumPoker";
import {
  DEFAULT_QUANTUM_POKER_BOT_PROFILES,
  JULES_PROFILE,
  NARI_PROFILE,
  QuantumPokerPersonaDriver,
  resolveQuantumPokerStrategyTuning,
} from "./quantumPokerPersona";

test("default persona pair matches the legacy poker bot profiles", () => {
  assert.deepEqual(DEFAULT_QUANTUM_POKER_BOT_PROFILES[0], NARI_PROFILE);
  assert.deepEqual(DEFAULT_QUANTUM_POKER_BOT_PROFILES[1], JULES_PROFILE);
  assert.equal(NARI_PROFILE.name, "Nari");
  assert.equal(NARI_PROFILE.persona, "tight");
  assert.equal(JULES_PROFILE.name, "Jules");
  assert.equal(JULES_PROFILE.persona, "loose");

  const nari = resolveQuantumPokerStrategyTuning(NARI_PROFILE);
  const jules = resolveQuantumPokerStrategyTuning(JULES_PROFILE);
  assert.ok(nari.callThreshold > jules.callThreshold);
  assert.ok(nari.raiseThreshold > jules.raiseThreshold);
});

test("Nari and Jules persona drivers can play a complete Quantum Poker hand", () => {
  const protocol = new QuantumPokerProtocol(4n);
  const drivers = {
    A: new QuantumPokerPersonaDriver("A", NARI_PROFILE),
    B: new QuantumPokerPersonaDriver("B", JULES_PROFILE),
  };
  const rng = mulberry32(2026);
  let state = protocol.initialState({
    tunnelId: "0x" + "98".repeat(32),
    initialBalances: { a: 10_000n, b: 10_000n },
  });
  let sawPrivateHoles = false;
  let sawResult = false;

  for (let steps = 0; steps < 500 && !sawResult; steps++) {
    let moved = false;
    for (const party of ["A", "B"] as Party[]) {
      const move = drivers[party].chooseMove(state, rng);
      if (!move) continue;
      state = protocol.applyMove(state, move, party);
      moved = true;

      const balances = protocol.balances(state);
      assert.equal(balances.a + balances.b, 20_000n);
      if (state.phase === "preflop_bet") {
        sawPrivateHoles = true;
        assert.ok(drivers.A.knownHoleCards(state));
        assert.ok(drivers.B.knownHoleCards(state));
      }
      if (state.phase === "hand_over" && state.lastResult) {
        sawResult = true;
      }
      break;
    }
    assert.ok(moved, `expected a persona move at phase ${state.phase}`);
  }

  assert.ok(sawPrivateHoles, "expected private hole cards to open locally");
  assert.ok(sawResult, "expected a hand result");
});
