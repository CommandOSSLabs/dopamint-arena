import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32 } from "../sim/rng";
import { FLEET_CELLS } from "./battleshipFleet";
import { BattleshipProtocol } from "./battleship";
import { playToCompletion, randomFleetSecret } from "./battleshipSelfPlay";
import { nextMove as nextMoveImport } from "./battleshipSelfPlay";

test("self-play reaches a verified decisive terminal", () => {
  const proto = new BattleshipProtocol(100n);
  const ctx = { tunnelId: "0x1", initialBalances: { a: 1000n, b: 1000n } };
  for (let seed = 1; seed <= 20; seed++) {
    const rng = mulberry32(seed);
    const secrets = { A: randomFleetSecret(rng), B: randomFleetSecret(rng) };
    const final = playToCompletion(
      proto,
      proto.initialState(ctx),
      secrets,
      rng,
    );
    assert.equal(final.phase, "over");
    assert.equal(final.balanceA + final.balanceB, final.total);
    // a decisive game sinks one fleet
    assert.ok(final.hitsOnA === FLEET_CELLS || final.hitsOnB === FLEET_CELLS);
  }
});

test("hit-keeps-turn: the driver never pipelines a shot on a hit", () => {
  const proto = new BattleshipProtocol(100n);
  const ctx = { tunnelId: "0x1", initialBalances: { a: 1000n, b: 1000n } };
  const rng = mulberry32(99);
  const secrets = { A: randomFleetSecret(rng), B: randomFleetSecret(rng) };
  let s = proto.initialState(ctx);
  // walk the driver and assert every hit-answer omits `next`
  // (drive until over)
  // eslint-disable-next-line no-constant-condition
  for (let i = 0; i < 5000; i++) {
    const driven = nextMoveImport(s, secrets, rng);
    if (!driven) break;
    if (driven.move.kind === "answer" && driven.move.isHit) {
      assert.equal(driven.move.next, undefined);
    }
    s = proto.applyMove(s, driven.move, driven.by);
  }
  assert.equal(s.phase, "over");
});
