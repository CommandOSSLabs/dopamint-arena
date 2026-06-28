import { test } from "node:test";
import assert from "node:assert/strict";

import { FLEET_CELLS, isLegalBoard } from "./fleet.ts";
import { CELL_COUNT } from "./fleet.ts";
import {
  type FleetSecret,
  makeFleetSecret,
  randomFleetSecret,
  secureSalt,
} from "./selfPlay.ts";
import { MultiGameBattleshipProtocol } from "../protocol/multiGameBattleship.ts";
import {
  type BattleshipTunnel,
  makeSeatBot,
  runBattleshipSelfPlayToEnd,
} from "../battleshipSelfPlay.ts";

function mockTunnel(proto: MultiGameBattleshipProtocol): BattleshipTunnel {
  const ctx = { tunnelId: "0x1", initialBalances: { a: 1000n, b: 1000n } };
  let state = proto.initialState(ctx);
  return {
    get state() {
      return state;
    },
    step(move: never, by: never) {
      state = proto.applyMove(state, move, by);
      return {} as never;
    },
  } as unknown as BattleshipTunnel;
}

function seatCtx(seed: number) {
  return {
    rngForSeat: () => {
      let x = seed >>> 0;
      return () => ((x = (x * 1664525 + 1013904223) >>> 0), x / 0x100000000);
    },
  };
}

function seedRng(s: number): () => number {
  let x = s >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0), x / 0x100000000);
}

function playToOver(seed: number) {
  const proto = new MultiGameBattleshipProtocol(100n);
  const t = mockTunnel(proto);
  const botA = makeSeatBot(
    "A",
    100n,
    "hard",
    randomFleetSecret(seedRng(seed)),
    true,
    seatCtx(seed),
  );
  const botB = makeSeatBot(
    "B",
    100n,
    "hard",
    randomFleetSecret(seedRng(seed + 50)),
    true,
    seatCtx(seed + 50),
  );
  runBattleshipSelfPlayToEnd(t, botA, botB, 5000);
  return t.state.inner; // BattleshipState
}

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

test("makeFleetSecret: single salt, legal board, 16-byte salt, 32-byte commitment", () => {
  const rng = seeded(3);
  const board = randomFleetSecret(rng).board;
  const salt = new Uint8Array(16).fill(42);
  const s = makeFleetSecret(board, salt);
  assert.equal(isLegalBoard(s.board), true);
  assert.equal(s.salt.length, 16);
  assert.equal(s.commitment.length, 32);
});

test("self-play reaches a decisive terminal each game; balances conserved", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const inner = playToOver(seed);
    assert.equal(inner.phase, "over");
    assert.equal(inner.balanceA + inner.balanceB, inner.total);
    assert.ok(
      inner.hitsOnA === FLEET_CELLS || inner.hitsOnB === FLEET_CELLS,
      `seed ${seed}: neither fleet fully sunk`,
    );
  }
});

test("kit-bot self-play game ends decisively with a winner", () => {
  const inner = playToOver(7);
  assert.equal(inner.phase, "over");
  assert.ok(
    inner.winner === 1 || inner.winner === 2,
    "expected a decisive winner",
  );
  assert.equal(inner.balanceA + inner.balanceB, inner.total);
});

// deterministic rng for reproducible fleets
function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}
