import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "../core/bytes";
import { generateKeyPair } from "../core/crypto";
import { defaultBackend } from "../core/crypto-native";
import { DistributedTunnel, Transport } from "../core/distributedTunnel";
import { makeEndpoint } from "../core/tunnel";
import { mulberry32 } from "../sim/rng";
import type { Balances } from "./Protocol";
import {
  BattleshipMove,
  BattleshipProtocol,
  BattleshipState,
} from "./battleship";
import { battleshipMoveCodec } from "./battleshipCodec";
import { nextMove, randomFleetSecret } from "./battleshipSelfPlay";

const BAL: Balances = { a: 1000n, b: 1000n };
const TUNNEL_ID = "0x" + "55".repeat(32);

function makeLoopback(): { a: Transport; b: Transport } {
  let aCb: ((f: Uint8Array) => void) | null = null;
  let bCb: ((f: Uint8Array) => void) | null = null;
  return {
    a: {
      send: (f) => bCb?.(f),
      onFrame: (cb) => {
        aCb = cb;
      },
    },
    b: {
      send: (f) => aCb?.(f),
      onFrame: (cb) => {
        bCb = cb;
      },
    },
  };
}

function makePair() {
  const loop = makeLoopback();
  const backend = defaultBackend();
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const protoA = new BattleshipProtocol(100n);
  const protoB = new BattleshipProtocol(100n);
  const dtA = new DistributedTunnel<BattleshipState, BattleshipMove>(
    protoA,
    {
      tunnelId: TUNNEL_ID,
      self: makeEndpoint(backend, "0xa11ce", keyA, true),
      opponent: makeEndpoint(backend, "0xb0b", keyB, false),
      selfParty: "A",
      moveCodec: battleshipMoveCodec,
    },
    loop.a,
    BAL,
  );
  const dtB = new DistributedTunnel<BattleshipState, BattleshipMove>(
    protoB,
    {
      tunnelId: TUNNEL_ID,
      self: makeEndpoint(backend, "0xb0b", keyB, true),
      opponent: makeEndpoint(backend, "0xa11ce", keyA, false),
      selfParty: "B",
      moveCodec: battleshipMoveCodec,
    },
    loop.b,
    BAL,
  );
  return { dtA, dtB, protoA };
}

test("battleship PvP pair co-signs to a decisive terminal with boards kept local", () => {
  const { dtA, dtB, protoA } = makePair();
  const rng = mulberry32(7);
  // Each seat owns ONLY its own fleet secret; the placeholder for the opponent
  // is never read by the driver for that seat.
  const secretA = randomFleetSecret(rng);
  const secretB = randomFleetSecret(rng);
  const placeholder = {
    board: new Uint8Array(0),
    salt: new Uint8Array(0),
    commitment: new Uint8Array(0),
  };
  const localA = { A: secretA, B: placeholder };
  const localB = { A: placeholder, B: secretB };

  let timestamp = 1n;

  // Drive: whichever seat must act computes its move from the SHARED public
  // state but its OWN secret, and proposes it through its own tunnel.
  for (let i = 0; i < 5000; i++) {
    const state = dtA.state as BattleshipState;
    if (state.phase === "over") break;
    // Determine the acting seat from public state by trying A then B.
    const drivenA = nextMove(state, localA, rng);
    const drivenB = nextMove(state, localB, rng);
    const driven =
      drivenA && drivenA.by === "A"
        ? { dt: dtA, ...drivenA }
        : drivenB && drivenB.by === "B"
          ? { dt: dtB, ...drivenB }
          : null;
    if (!driven) break;
    driven.dt.propose(driven.move, timestamp++);
  }

  assert.equal((dtA.state as BattleshipState).phase, "over");
  // Both tunnels must agree on the final encoded state.
  assert.equal(
    toHex(protoA.encodeState(dtA.state as BattleshipState)),
    toHex(protoA.encodeState(dtB.state as BattleshipState)),
  );
});
