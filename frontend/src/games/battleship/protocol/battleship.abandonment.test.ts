// Channel-close safety review (SolEng) — Battleship.
//
// battleship.test.ts already proves the GOOD properties: the Merkle commit-reveal binds the
// board (a defender CANNOT lie about a hit/miss — a flipped result fails verifyCell), commits
// are ordered, and the happy path shifts the stake to the winner. This file fills the gap
// those leave: Kostas's invariant 3 — "you lose your money if you don't progress."
//
// Battleship is REAL cross-wallet PvP with money at risk (useBattleshipPvp.ts opens a funded
// tunnel, STAKE_BALANCE = 1 MTPS per seat, STAKE_SHIFT = 0.2 MTPS to the winner) — NOT a stub.
// It opens with penaltyAmount = 0 (the default in tunnelTx.ts), and there is no battleship
// referee, so settlement is cooperative or a GAME-BLIND `force_close_after_timeout` that pays
// the latest co-signed balances + a flat penalty of ZERO.
//
// The stake shifts loser -> winner ONLY inside applyReveal, when the reveal completes the sink
// (hitsOn* === FLEET_CELLS). That reveal is authored by the DEFENDER — the seat that is losing.
// So the losing defender simply withholds the fatal reveal: balances stay even, the attacker
// cannot self-advance, and the penalty-0 close pays the even state. The winner never collects.
//
// The on-chain half (penalty-0 force_close pays the even state) is proven generically in
// sui_tunnel/tests/game_close_safety_tests.move; here we prove the battleship-specific fact
// that the settling move belongs to the losing seat.

import { test } from "node:test";
import assert from "node:assert/strict";

import { BattleshipProtocol } from "./battleship.ts";
import { CELL_COUNT, FLEET_CELLS } from "../engine/fleet.ts";
import { type FleetSecret, nextMove, randomFleetSecret } from "../engine/selfPlay.ts";

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

const CTX = { tunnelId: "t-abandon", initialBalances: { a: 1000n, b: 1000n } };

function secrets(seedA: number, seedB: number): { A: FleetSecret; B: FleetSecret } {
  return { A: randomFleetSecret(mulberry32(seedA)), B: randomFleetSecret(mulberry32(seedB)) };
}

/** Drive play to "A has sunk all but B's LAST ship cell", with the turn back on A. */
function aboutToSinkB(proto: BattleshipProtocol, s: { A: FleetSecret; B: FleetSecret }) {
  let st = proto.initialState(CTX);
  st = proto.applyMove(st, { type: "commit", root: s.A.commitment.root }, "A");
  st = proto.applyMove(st, { type: "commit", root: s.B.commitment.root }, "B");

  const bShips: number[] = [];
  const aWater: number[] = [];
  for (let c = 0; c < CELL_COUNT; c++) {
    if (s.B.board[c] === 1) bShips.push(c);
    if (s.A.board[c] === 0) aWater.push(c);
  }
  assert.equal(bShips.length, FLEET_CELLS);

  // Hit every B ship but the last; between hits, B fires a harmless miss so the turn returns to A.
  let water = 0;
  for (let i = 0; i < FLEET_CELLS - 1; i++) {
    st = proto.applyMove(st, { type: "shoot", cell: bShips[i] }, "A");
    const hit = nextMove(st, s, mulberry32(1))!;
    st = proto.applyMove(st, hit.move, hit.by); // B reveals the hit
    st = proto.applyMove(st, { type: "shoot", cell: aWater[water++] }, "B");
    const miss = nextMove(st, s, mulberry32(1))!;
    st = proto.applyMove(st, miss.move, miss.by); // A reveals the miss; turn back to A
  }
  assert.equal(st.hitsOnB, FLEET_CELLS - 1);
  assert.equal(st.turn, "A");
  return { st, lastShip: bShips[FLEET_CELLS - 1] };
}

// RED — the gap (this test FAILS today; that is the point — it must show up in CI).
test("SECURITY (F1): an honest winner can sink the last cell WITHOUT the losing defender's reveal", () => {
  const proto = new BattleshipProtocol(100n);
  const s = secrets(7, 8);
  const { st, lastShip } = aboutToSinkB(proto, s);

  // A fires the fatal shot. The stake shifts ONLY when B reveals this cell as a hit.
  const sFatal = proto.applyMove(st, { type: "shoot", cell: lastShip }, "A");
  assert.deepEqual(sFatal.pendingShot, { by: "A", cell: lastShip });
  assert.equal(sFatal.balanceA, 1000n); // stake NOT yet moved — balances even
  assert.equal(sFatal.balanceB, 1000n);

  // The cooperative continuation needs B's reveal — which WOULD settle A's win:
  const fatalReveal = nextMove(sFatal, s, mulberry32(1))!;
  assert.equal(fatalReveal.by, "B");
  const sWin = proto.applyMove(sFatal, fatalReveal.move, fatalReveal.by);
  assert.equal(sWin.winner, 1);
  assert.ok(sWin.balanceA > 1000n, "B's reveal would hand A the stake");

  // A cannot self-settle — the chain proves EVEN is its ceiling: it can neither fire again
  // (a reveal is owed) nor reveal on B's behalf.
  const otherCell = lastShip === 0 ? 1 : 0;
  assert.throws(
    () => proto.applyMove(sFatal, { type: "shoot", cell: otherCell }, "A"),
    /awaiting the previous shot/,
  );
  assert.throws(
    () => proto.applyMove(sFatal, fatalReveal.move, "A"),
    /only the defender reveals/,
  );

  // penaltyAmount = 0, so the game-blind force_close pays exactly these EVEN balances. Assert
  // the SAFE outcome we want — it fails (the losing defender keeps the stake it was about to lose).
  assert.ok(
    sFatal.balanceA > 1000n,
    "an honest battleship winner must be able to claim the stake it won when the losing " +
      "defender withholds the fatal reveal — today it can only settle EVEN (penalty=0)",
  );
});
