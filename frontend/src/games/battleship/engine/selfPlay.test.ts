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
} from "./selfPlay.ts";
import { BattleshipProtocol } from "../protocol/battleship.ts";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CTX = { tunnelId: "t1", initialBalances: { a: 1000n, b: 1000n } };

test("randomFleetSecret builds a legal board, 100 salts, and a 32-byte commitment", () => {
  const fleet = randomFleetSecret(mulberry32(1));
  assert.equal(isLegalBoard(fleet.board), true);
  assert.equal(fleet.salts.length, CELL_COUNT);
  assert.equal(fleet.commitment.root.length, 32);
});

test("makeFleetSecret recomputes the committed root from board + salts", () => {
  const fleet = randomFleetSecret(mulberry32(2));
  const again = makeFleetSecret(fleet.board, fleet.salts);
  assert.deepEqual(again.commitment.root, fleet.commitment.root);
});

test("nextMove sequences commit A, commit B, shoot, then reveal", () => {
  const proto = new BattleshipProtocol();
  const secrets: { A: FleetSecret; B: FleetSecret } = {
    A: randomFleetSecret(mulberry32(3)),
    B: randomFleetSecret(mulberry32(4)),
  };
  let st = proto.initialState(CTX);

  const m1 = nextMove(st, secrets, mulberry32(1))!;
  assert.equal(m1.by, "A");
  assert.equal(m1.move.type, "commit");
  st = proto.applyMove(st, m1.move, m1.by);

  const m2 = nextMove(st, secrets, mulberry32(1))!;
  assert.equal(m2.by, "B");
  assert.equal(m2.move.type, "commit");
  st = proto.applyMove(st, m2.move, m2.by);

  const m3 = nextMove(st, secrets, mulberry32(1))!;
  assert.equal(m3.by, "A");
  assert.equal(m3.move.type, "shoot");
  st = proto.applyMove(st, m3.move, m3.by);

  const m4 = nextMove(st, secrets, mulberry32(1))!;
  assert.equal(m4.by, "B");
  assert.equal(m4.move.type, "reveal");
});

test("a full self-play game terminates with a winner and conserved balances", () => {
  const proto = new BattleshipProtocol(100n);
  for (let seed = 1; seed <= 25; seed++) {
    const secrets = {
      A: randomFleetSecret(mulberry32(seed * 2)),
      B: randomFleetSecret(mulberry32(seed * 2 + 1)),
    };
    const final = playToCompletion(
      proto,
      proto.initialState(CTX),
      secrets,
      mulberry32(seed),
    );

    assert.ok(
      final.winner === 1 || final.winner === 2,
      `decisive winner for seed ${seed}`,
    );
    assert.equal(final.phase, "over");
    assert.equal(final.balanceA + final.balanceB, final.total);
    if (final.winner === 1) {
      assert.equal(final.hitsOnB, FLEET_CELLS);
      assert.equal(final.balanceA, 1100n);
      assert.equal(final.balanceB, 900n);
    } else {
      assert.equal(final.hitsOnA, FLEET_CELLS);
      assert.equal(final.balanceB, 1100n);
      assert.equal(final.balanceA, 900n);
    }
  }
});
