import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "../core/bytes";
import { fieldSafeScalar, hashToFieldSafeScalar } from "./scalars";
import {
  buildQuantumPokerResultPublicInputs,
  QUANTUM_POKER_RESULT_PUBLIC_INPUT_COUNT,
  quantumPokerResultHash,
  quantumPokerRulesHash,
  tunnelIdHash,
  UnavailableQuantumPokerResultProver,
} from "./quantumPokerResultCircuit";

test("fieldSafeScalar clears top three bits without mutating input", () => {
  const raw = new Uint8Array(32).fill(0xff);
  const scalar = fieldSafeScalar(raw);
  assert.equal(raw[31], 0xff);
  assert.equal(scalar[31], 0x1f);
  assert.equal(scalar.length, 32);
  assert.throws(() => fieldSafeScalar(new Uint8Array(31)), /32 bytes/);
});

test("hashToFieldSafeScalar produces a 32-byte scalar under 2^253", () => {
  const scalar = hashToFieldSafeScalar(new TextEncoder().encode("quantum"));
  assert.equal(scalar.length, 32);
  assert.equal((scalar[31] & 0xe0) === 0, true);
});

test("Quantum Poker result public inputs use exactly eight field-safe scalars", () => {
  const highHash = new Uint8Array(32).fill(0xff);
  const resultHash = quantumPokerResultHash({
    handId: 7,
    winner: 0,
    partyABalance: 1200,
    partyBBalance: 800,
    board: [1, 2, 3, 4, 5],
    shownHoleA: [6, 7],
    shownHoleB: [8, 9],
    scoreA: 123,
    scoreB: 100,
  });
  const inputs = buildQuantumPokerResultPublicInputs({
    rulesHash: highHash,
    tunnelId: "0x" + "11".repeat(32),
    stateHash: highHash,
    handId: 7,
    winner: 0,
    partyABalance: 1200,
    partyBBalance: 800,
    resultHash,
  });

  assert.equal(inputs.length, QUANTUM_POKER_RESULT_PUBLIC_INPUT_COUNT * 32);
  assert.equal(inputs[31], 0x1f);
  assert.equal(inputs[95], 0x1f);
  assert.equal(inputs[96], 7);
  assert.equal(inputs[128], 0);
  assert.equal(inputs[160], 0xb0);
  assert.equal(inputs[161], 0x04);
  assert.equal((inputs[255] & 0xe0) === 0, true);
});

test("rules and tunnel hashes are deterministic", () => {
  assert.equal(toHex(quantumPokerRulesHash()), toHex(quantumPokerRulesHash()));
  assert.equal(
    toHex(tunnelIdHash("0x" + "22".repeat(32))),
    toHex(tunnelIdHash("0x" + "22".repeat(32)))
  );
});

test("UnavailableQuantumPokerResultProver throws with deployment guidance", async () => {
  await assert.rejects(
    () =>
      new UnavailableQuantumPokerResultProver().prove(
        {
          rulesHash: new Uint8Array(32),
          tunnelId: "0x" + "33".repeat(32),
          stateHash: new Uint8Array(32),
          handId: 0,
          winner: 2,
          partyABalance: 1000,
          partyBBalance: 1000,
          resultHash: new Uint8Array(32),
        },
        {}
      ),
    /trusted setup/
  );
});
