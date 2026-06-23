import { test } from "node:test";
import assert from "node:assert/strict";
import { loadOrCreateQuantumPokerBots, MIN_PLAY_MIST } from "./bots";

// Minimal localStorage shim for node:test (jsdom-free).
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

test("loadOrCreateQuantumPokerBots persists the same two identities", () => {
  const first = loadOrCreateQuantumPokerBots();
  const second = loadOrCreateQuantumPokerBots();
  assert.equal(first.A.address, second.A.address);
  assert.equal(first.B.address, second.B.address);
  assert.notEqual(first.A.address, first.B.address);
});

test("bot off-chain and on-chain public keys match", () => {
  const { A } = loadOrCreateQuantumPokerBots();
  assert.equal(
    Buffer.from(A.coreKey.publicKey).toString("hex"),
    Buffer.from(A.keypair.getPublicKey().toRawBytes()).toString("hex"),
  );
});

test("MIN_PLAY_MIST covers one open plus both stakes", () => {
  // 0.02 SUI must exceed 2x stake (20_000 MIST) by a wide margin for gas.
  assert.ok(MIN_PLAY_MIST > 20_000n);
});
