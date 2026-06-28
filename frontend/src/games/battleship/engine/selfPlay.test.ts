import { test } from "node:test";
import assert from "node:assert/strict";

import { FLEET_CELLS, isLegalBoard } from "./fleet.ts";
import { CELL_COUNT } from "./fleet.ts";
import {
  type FleetSecret,
  makeFleetSecret,
  nextMove,
  playToCompletion,
  randomFleetSecret,
  secureSalt,
} from "./selfPlay.ts";
import { BattleshipProtocol } from "sui-tunnel-ts/protocol/battleship";

test("randomFleetSecret yields a legal board with a 16-byte salt", () => {
  const s: FleetSecret = randomFleetSecret(seeded(1));
  assert.equal(s.board.length, CELL_COUNT);
  assert.equal(isLegalBoard(s.board), true);
  assert.equal(s.salt.length, 16);
  assert.equal(s.commitment.length, 32);
});

test("secureSalt returns 16 bytes", () => {
  assert.equal(secureSalt().length, 16);
});

test("self-play reaches a decisive terminal each game; balances conserved", () => {
  const proto = new BattleshipProtocol(100n);
  const ctx = { tunnelId: "0x1", initialBalances: { a: 1000n, b: 1000n } };
  for (let seed = 1; seed <= 20; seed++) {
    const rng = seeded(seed);
    const secrets = { A: randomFleetSecret(rng), B: randomFleetSecret(rng) };
    const final = playToCompletion(
      proto,
      proto.initialState(ctx),
      secrets,
      rng,
    );
    assert.equal(final.phase, "over");
    assert.equal(final.balanceA + final.balanceB, final.total);
    assert.ok(final.hitsOnA === FLEET_CELLS || final.hitsOnB === FLEET_CELLS);
  }
});

test("driver answers bare (no pipelined next) and reveals at game end", () => {
  const proto = new BattleshipProtocol(100n);
  const ctx = { tunnelId: "0x1", initialBalances: { a: 1000n, b: 1000n } };
  const rng = seeded(7);
  const secrets = { A: randomFleetSecret(rng), B: randomFleetSecret(rng) };
  let s = proto.initialState(ctx);
  let sawReveal = false;
  for (let i = 0; i < 5000; i++) {
    const d = nextMove(s, secrets, rng);
    if (!d) break;
    if (d.move.kind === "answer") assert.equal(d.move.next, undefined);
    if (d.move.kind === "reveal_board") sawReveal = true;
    s = proto.applyMove(s, d.move, d.by);
  }
  assert.equal(s.phase, "over");
  assert.equal(sawReveal, true);
});

// deterministic rng for reproducible fleets
function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}
