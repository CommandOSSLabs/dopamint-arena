import { test } from "node:test";
import assert from "node:assert/strict";

import { createParticipant } from "sui-tunnel-ts/core/keys";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import {
  DistributedTunnel,
  type Transport,
} from "sui-tunnel-ts/core/distributedTunnel";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  BattleshipProtocol,
  battleshipMoveCodec,
  type BattleshipMove,
  type BattleshipState,
} from "../protocol/battleship";
import { FLEET_CELLS } from "./fleet";
import { type FleetSecret, randomFleetSecret } from "./selfPlay";
import { proposeDue } from "./pvpDriver";

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

const LOCKED = 500n;
const TUNNEL_ID = `0x${"11".repeat(32)}`;

/** Two transports whose frames cross over, delivered iteratively by `pump` (no deep recursion). */
function pairedTransports() {
  let aCb: (f: Uint8Array) => void = () => {};
  let bCb: (f: Uint8Array) => void = () => {};
  const queue: Array<() => void> = [];
  const tA: Transport = {
    send: (f) => queue.push(() => bCb(f)),
    onFrame: (cb) => (aCb = cb),
  };
  const tB: Transport = {
    send: (f) => queue.push(() => aCb(f)),
    onFrame: (cb) => (bCb = cb),
  };
  const pump = () => {
    let guard = 0;
    while (queue.length) {
      if (++guard > 50_000)
        throw new Error("pump runaway — game did not converge");
      queue.shift()!();
    }
  };
  return { tA, tB, pump };
}

type DT = DistributedTunnel<BattleshipState, BattleshipMove>;

function firstUnfired(st: BattleshipState, role: Party): number {
  const atOpponent = role === "A" ? st.shotsAtB : st.shotsAtA;
  const fired = new Set(atOpponent.map((s) => s.cell));
  for (let c = 0; c < 100; c++) if (!fired.has(c)) return c;
  return -1;
}

/** Wire a seat to auto-commit, auto-reveal (proposeDue) and auto-fire (stands in for the human). */
function autoSeat(dt: DT, role: Party, secret: FleetSecret) {
  dt.onConfirmed = () => {
    if (proposeDue(dt, role, secret)) return;
    const st = dt.state;
    if (
      st.phase === "playing" &&
      !st.pendingShot &&
      st.turn === role &&
      st.winner === 0
    ) {
      const cell = firstUnfired(st, role);
      if (cell >= 0) dt.propose({ type: "shoot", cell }, 0n);
    }
  };
}

function makeSeat(
  role: Party,
  self: FleetSecret,
  transport: Transport,
  selfKeys: ReturnType<typeof createParticipant>,
  oppKeys: ReturnType<typeof createParticipant>,
): DT {
  const backend = defaultBackend();
  return new DistributedTunnel<BattleshipState, BattleshipMove>(
    new BattleshipProtocol(100n),
    {
      tunnelId: TUNNEL_ID,
      self: makeEndpoint(backend, selfKeys.address, selfKeys.keyPair, true),
      opponent: makeEndpoint(
        backend,
        oppKeys.address,
        {
          publicKey: oppKeys.keyPair.publicKey,
          scheme: oppKeys.keyPair.scheme,
        },
        false,
      ),
      selfParty: role,
      moveCodec: battleshipMoveCodec,
    },
    transport,
    { a: LOCKED, b: LOCKED },
  );
}

test("two independent seats play a full commit-reveal game to a settled winner", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const A = createParticipant("A");
    const B = createParticipant("B");
    const secretA = randomFleetSecret(mulberry32(seed * 3));
    const secretB = randomFleetSecret(mulberry32(seed * 3 + 1));
    const { tA, tB, pump } = pairedTransports();

    const dtA = makeSeat("A", secretA, tA, A, B);
    const dtB = makeSeat("B", secretB, tB, B, A);
    autoSeat(dtA, "A", secretA);
    autoSeat(dtB, "B", secretB);

    // Kick off the ordered commits; the reactive handlers carry it to the end.
    proposeDue(dtA, "A", secretA);
    pump();

    // Both engines independently reach the SAME terminal public state.
    assert.notEqual(dtA.state.winner, 0, `seed ${seed} decisive`);
    assert.equal(
      dtA.state.winner,
      dtB.state.winner,
      `seed ${seed} agree on winner`,
    );
    assert.deepEqual(
      dtA.protocol.encodeState(dtA.state),
      dtB.protocol.encodeState(dtB.state),
      `seed ${seed} identical co-signed state`,
    );

    const winner = dtA.state.winner;
    const loserSunk = winner === 1 ? dtA.state.hitsOnB : dtA.state.hitsOnA;
    assert.equal(loserSunk, FLEET_CELLS, `seed ${seed} loser fully sunk`);
    assert.equal(dtA.state.balanceA + dtA.state.balanceB, 2n * LOCKED);
    assert.equal(
      winner === 1 ? dtA.state.balanceA : dtA.state.balanceB,
      LOCKED + 100n,
    );
  }
});

test("a reveal that lies about a hit is rejected, halting the cheat", () => {
  const A = createParticipant("A");
  const B = createParticipant("B");
  const secretA = randomFleetSecret(mulberry32(101));
  const secretB = randomFleetSecret(mulberry32(102));
  const { tA, tB, pump } = pairedTransports();
  const dtA = makeSeat("A", secretA, tA, A, B);
  const dtB = makeSeat("B", secretB, tB, B, A);

  // A and B commit; then A fires at one of B's known ship cells.
  autoSeat(dtB, "B", secretB); // B reveals honestly + plays normally
  dtA.onConfirmed = () => {
    proposeDue(dtA, "A", secretA);
  };
  proposeDue(dtA, "A", secretA);
  pump();

  const shipCell = secretB.board.findIndex((v) => v === 1);
  // A's engine, asked to apply B's reveal that falsely claims the ship cell is water,
  // recomputes the Merkle leaf and the proof fails — applyMove throws.
  assert.throws(() =>
    dtA.protocol.applyMove(
      {
        ...dtA.state,
        pendingShot: { by: "A", cell: shipCell },
        phase: "playing",
      },
      {
        type: "reveal",
        cell: shipCell,
        isShip: false, // the lie
        salt: secretB.salts[shipCell],
        proof: [],
      },
      "B",
    ),
  );
});
