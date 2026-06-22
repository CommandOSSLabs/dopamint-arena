import test from "node:test";
import assert from "node:assert/strict";
import { makeBattleshipResumeAdapter } from "./battleshipResumeAdapter";
import { makeFleetSecret } from "./engine/selfPlay";
import { placementsToBoard } from "./engine/fleet";
import { randomSalts } from "./engine/merkle";

// deriveBattleshipView/fleetStatus need Placement[] for per-ship damage, and placements are NOT
// reconstructable from the 0/1 board — so the resume secret must carry both the fleet AND the
// placements, captured/restored through the hidden-secret channel (never via serializeState).
test("battleship secret blob round-trips fleet + placements; serializeState excludes both", () => {
  const placements = [{ id: "carrier", cell: 0, orient: "H" as const }];
  const fleet = makeFleetSecret(placementsToBoard(placements), randomSalts());
  let store: { fleet: unknown; placements: unknown } = { fleet, placements };
  const adapter = makeBattleshipResumeAdapter({
    getSecret: () => store.fleet as never,
    getPlacements: () => store.placements as never,
    setSecret: (s) => {
      store.fleet = s;
    },
    setPlacements: (p) => {
      store.placements = p;
    },
  });
  const captured = adapter.captureSecret!();
  store = { fleet: null, placements: null };
  adapter.restoreSecret!(captured);
  assert.ok(store.fleet);
  assert.deepEqual(store.placements, placements);
  const pub = adapter.serializeState({
    commitA: null,
    commitB: null,
  } as never) as Record<string, unknown>;
  assert.equal(pub.salts, undefined);
  assert.equal(pub.placements, undefined);
});
