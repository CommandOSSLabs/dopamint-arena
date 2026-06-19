import { test } from "node:test";
import assert from "node:assert/strict";

import { BattleshipProtocol, type BattleshipState } from "./battleship.ts";
import { FLEET_CELLS } from "../engine/fleet.ts";
import {
  type FleetSecret,
  nextMove,
  randomFleetSecret,
} from "../engine/selfPlay.ts";

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

function secrets(
  seedA: number,
  seedB: number,
): { A: FleetSecret; B: FleetSecret } {
  return {
    A: randomFleetSecret(mulberry32(seedA)),
    B: randomFleetSecret(mulberry32(seedB)),
  };
}

function commitBoth(
  proto: BattleshipProtocol,
  s: { A: FleetSecret; B: FleetSecret },
): BattleshipState {
  let st = proto.initialState(CTX);
  st = proto.applyMove(st, { type: "commit", root: s.A.commitment.root }, "A");
  st = proto.applyMove(st, { type: "commit", root: s.B.commitment.root }, "B");
  return st;
}

test("initialState locks balances, clamps stake, and waits for commits", () => {
  const proto = new BattleshipProtocol(100n);
  const st = proto.initialState(CTX);
  assert.equal(st.phase, "awaitingCommits");
  assert.equal(st.turn, "A");
  assert.equal(st.total, 2000n);
  assert.equal(st.stake, 100n);
  assert.equal(st.winner, 0);
  assert.equal(st.commitA, null);

  // Stake cannot exceed what the poorer party could lose.
  const poor = proto.initialState({
    tunnelId: "t",
    initialBalances: { a: 40n, b: 1000n },
  });
  assert.equal(poor.stake, 40n);
});

test("commits are ordered A then B and open play once both arrive", () => {
  const proto = new BattleshipProtocol();
  const s = secrets(1, 2);
  let st = proto.initialState(CTX);

  assert.throws(() =>
    proto.applyMove(st, { type: "commit", root: s.B.commitment.root }, "B"),
  );
  st = proto.applyMove(st, { type: "commit", root: s.A.commitment.root }, "A");
  assert.equal(st.phase, "awaitingCommits");
  assert.throws(() =>
    proto.applyMove(st, { type: "commit", root: s.A.commitment.root }, "A"),
  );
  st = proto.applyMove(st, { type: "commit", root: s.B.commitment.root }, "B");
  assert.equal(st.phase, "playing");
  assert.equal(st.turn, "A");
  assert.throws(() =>
    proto.applyMove(st, { type: "commit", root: s.A.commitment.root }, "A"),
  );
});

test("firing is gated by phase, turn, range, the pending reveal, and prior shots", () => {
  const proto = new BattleshipProtocol();
  const s = secrets(3, 4);
  const fresh = proto.initialState(CTX);
  assert.throws(() => proto.applyMove(fresh, { type: "shoot", cell: 0 }, "A")); // before commits

  let st = commitBoth(proto, s);
  assert.throws(() => proto.applyMove(st, { type: "shoot", cell: 0 }, "B")); // not B's turn
  assert.throws(() => proto.applyMove(st, { type: "shoot", cell: 100 }, "A")); // out of range

  st = proto.applyMove(st, { type: "shoot", cell: 0 }, "A");
  assert.deepEqual(st.pendingShot, { by: "A", cell: 0 });
  assert.throws(() => proto.applyMove(st, { type: "shoot", cell: 1 }, "A")); // reveal owed first
});

test("only the defender reveals, for the pending cell, with a valid proof", () => {
  const proto = new BattleshipProtocol();
  const s = secrets(5, 6);
  let st = commitBoth(proto, s);
  st = proto.applyMove(st, { type: "shoot", cell: 0 }, "A");

  const truth = {
    cell: 0,
    isShip: s.B.board[0] === 1,
    salt: s.B.salts[0],
  } as const;
  const proof = nextMove(st, s, mulberry32(1))!.move; // the correct reveal for the pending shot
  assert.equal(proof.type, "reveal");

  // Wrong revealer, wrong cell, lied result — all rejected.
  assert.throws(() =>
    proto.applyMove(st, { ...(proof as object) } as never, "A"),
  );
  assert.throws(() =>
    proto.applyMove(
      st,
      {
        type: "reveal",
        cell: 1,
        isShip: truth.isShip,
        salt: truth.salt,
        proof: [],
      },
      "B",
    ),
  );
  assert.throws(() =>
    proto.applyMove(
      st,
      {
        type: "reveal",
        cell: 0,
        isShip: !truth.isShip,
        salt: truth.salt,
        proof: (proof as { proof: Uint8Array[] }).proof,
      },
      "B",
    ),
  );

  // The honest reveal lands and passes the turn to B.
  st = proto.applyMove(st, proof, "B");
  assert.equal(st.pendingShot, null);
  assert.equal(st.turn, "B");
  assert.equal(st.shotsAtB.length, 1);
  assert.equal(st.hitsOnB, truth.isShip ? 1 : 0);
});

test("destroying a fleet ends the game and shifts the stake to the winner", () => {
  const proto = new BattleshipProtocol(100n);
  const s = secrets(7, 8);
  let st = commitBoth(proto, s);

  const bShips: number[] = [];
  const aWater: number[] = [];
  for (let c = 0; c < 100; c++) {
    if (s.B.board[c] === 1) bShips.push(c);
    if (s.A.board[c] === 0) aWater.push(c);
  }
  assert.equal(bShips.length, FLEET_CELLS);

  let water = 0;
  for (const target of bShips) {
    st = proto.applyMove(st, { type: "shoot", cell: target }, "A");
    const rev = nextMove(st, s, mulberry32(1))!;
    st = proto.applyMove(st, rev.move, rev.by); // B reveals a hit
    if (st.winner !== 0) break;
    st = proto.applyMove(st, { type: "shoot", cell: aWater[water++] }, "B");
    const miss = nextMove(st, s, mulberry32(1))!;
    st = proto.applyMove(st, miss.move, miss.by); // A reveals a miss
  }

  assert.equal(st.winner, 1);
  assert.equal(st.phase, "over");
  assert.equal(proto.isTerminal(st), true);
  assert.equal(st.hitsOnB, FLEET_CELLS);
  assert.equal(st.balanceA, 1100n);
  assert.equal(st.balanceB, 900n);
  assert.equal(st.balanceA + st.balanceB, st.total);
});

test("encodeState is deterministic and changes when public state changes", () => {
  const proto = new BattleshipProtocol();
  const s = secrets(9, 10);
  const a = proto.initialState(CTX);
  assert.deepEqual(proto.encodeState(a), proto.encodeState(a));

  const committed = proto.applyMove(
    a,
    { type: "commit", root: s.A.commitment.root },
    "A",
  );
  assert.notDeepEqual(proto.encodeState(a), proto.encodeState(committed));

  const playing = commitBoth(proto, s);
  const afterShot = proto.applyMove(playing, { type: "shoot", cell: 0 }, "A");
  assert.notDeepEqual(proto.encodeState(playing), proto.encodeState(afterShot));
});

test("randomMove only fires, and only on the mover's turn", () => {
  const proto = new BattleshipProtocol();
  const s = secrets(11, 12);
  const waiting = proto.initialState(CTX);
  assert.equal(proto.randomMove(waiting, "A", mulberry32(1)), null); // can't commit blindly

  const playing = commitBoth(proto, s);
  const aMove = proto.randomMove(playing, "A", mulberry32(1));
  assert.equal(aMove?.type, "shoot");
  assert.equal(proto.randomMove(playing, "B", mulberry32(1)), null); // not B's turn

  const pending = proto.applyMove(playing, { type: "shoot", cell: 0 }, "A");
  assert.equal(proto.randomMove(pending, "B", mulberry32(1)), null); // reveal owed, not a shot
});
