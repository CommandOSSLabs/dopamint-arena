import test from "node:test";
import assert from "node:assert/strict";
import { makeBattleshipResumeAdapter } from "./battleshipResumeAdapter";
import { randomFleetSecret } from "./engine/selfPlay";

test("the fleet secret round-trips locally and never enters a resync/serializeState payload", () => {
  let stored: unknown = null;
  // Deterministic varied rng — a constant rng exhausts the fleet placement budget.
  let seed = 0x9e3779b9;
  const rng = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const secret = randomFleetSecret(rng);
  const adapter = makeBattleshipResumeAdapter({
    getSecret: () => secret,
    setSecret: (s) => {
      stored = s;
    },
  });
  // A representative public state (no fleet).
  const state = {
    phase: "playing",
    turn: "A",
    pendingShot: null,
    commitA: null,
    commitB: null,
    shotsAtA: [],
    shotsAtB: [],
    hitsOnA: 0,
    hitsOnB: 0,
    winner: 0,
    balanceA: 500n,
    balanceB: 500n,
    total: 1000n,
    stake: 100n,
  };
  const serialized = adapter.serializeState(state as never);
  const blob = JSON.stringify(serialized, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  // No fleet salt bytes leak into the wire-bound state.
  for (const salt of secret.salts) {
    assert.ok(
      !blob.includes(Array.from(salt).join(",")),
      "fleet salt leaked into serializeState",
    );
  }
  // No 0/1 fleet board bytes leak into the wire-bound state.
  assert.ok(
    !blob.includes(Array.from(secret.board).join(",")),
    "fleet board leaked into serializeState",
  );
  // captureSecret is the ONLY carrier of the secret; restoreSecret round-trips it.
  const cap = adapter.captureSecret!();
  adapter.restoreSecret!(cap);
  assert.deepEqual(stored, secret);
});
