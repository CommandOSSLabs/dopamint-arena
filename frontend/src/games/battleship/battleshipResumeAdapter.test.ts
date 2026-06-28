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
  const placements = [{ id: "carrier", cell: 0, orient: "H" as const }];
  let storedPlacements: unknown = null;
  const adapter = makeBattleshipResumeAdapter({
    getSecret: () => secret,
    setSecret: (s) => {
      stored = s;
    },
    getPlacements: () => placements,
    setPlacements: (p) => {
      storedPlacements = p;
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
  assert.ok(
    !blob.includes(Array.from(secret.salt).join(",")),
    "fleet salt leaked into serializeState",
  );
  // No 0/1 fleet board bytes leak into the wire-bound state.
  assert.ok(
    !blob.includes(Array.from(secret.board).join(",")),
    "fleet board leaked into serializeState",
  );
  // captureSecret is the ONLY carrier of the secret; restoreSecret round-trips it.
  // Simulate a localStorage round-trip (JSON stringify then parse) to prove the
  // captured blob carries a single `salt` (16 bytes) rather than per-cell `salts`.
  const cap = adapter.captureSecret!();
  const roundTripped = JSON.parse(JSON.stringify(cap)) as {
    fleet: { board: number[]; salt: number[] };
  };
  assert.equal(roundTripped.fleet.salt.length, 16, "captured salt must be 16 bytes");
  adapter.restoreSecret!(cap);
  const restoredSecret = stored as { board: Uint8Array; salt: Uint8Array };
  assert.ok(restoredSecret.salt instanceof Uint8Array, "restored salt is a Uint8Array");
  assert.equal(restoredSecret.salt.length, 16, "restored salt is 16 bytes");
  assert.deepEqual(Array.from(restoredSecret.board), Array.from(secret.board), "board round-trips");
  assert.deepEqual(storedPlacements, placements);
});
