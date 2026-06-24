import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "../core/bytes";
import { generateKeyPair, KeyPair, verify } from "../core/crypto";
import { defaultBackend } from "../core/crypto-native";
import { DistributedTunnel, Transport } from "../core/distributedTunnel";
import { makeEndpoint } from "../core/tunnel";
import { serializeSettlementWithRoot } from "../core/wire";
import { Transcript } from "../proof/transcript";
import { mulberry32 } from "../sim/rng";
import type { Balances, Party } from "./Protocol";
import {
  PokerMove,
  PokerState,
  QuantumPokerProtocol,
  QuantumPokerSeatDriver,
} from "./quantumPoker";
import { pokerMoveCodec } from "./quantumPokerCodec";

const BAL: Balances = { a: 10_000n, b: 10_000n };
const TUNNEL_ID = "0x" + "77".repeat(32);

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

function makePair(): {
  dtA: DistributedTunnel<PokerState, PokerMove>;
  dtB: DistributedTunnel<PokerState, PokerMove>;
  protoA: QuantumPokerProtocol;
  protoB: QuantumPokerProtocol;
  keyA: KeyPair;
  keyB: KeyPair;
} {
  const loop = makeLoopback();
  const backend = defaultBackend();
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const addrA = "0xa11ce";
  const addrB = "0xb0b";
  const protoA = new QuantumPokerProtocol(4n);
  const protoB = new QuantumPokerProtocol(4n);
  const dtA = new DistributedTunnel(
    protoA,
    {
      tunnelId: TUNNEL_ID,
      self: makeEndpoint(backend, addrA, keyA, true),
      opponent: makeEndpoint(backend, addrB, keyB, false),
      selfParty: "A",
      moveCodec: pokerMoveCodec,
    },
    loop.a,
    BAL
  );
  const dtB = new DistributedTunnel(
    protoB,
    {
      tunnelId: TUNNEL_ID,
      self: makeEndpoint(backend, addrB, keyB, true),
      opponent: makeEndpoint(backend, addrA, keyA, false),
      selfParty: "B",
      moveCodec: pokerMoveCodec,
    },
    loop.b,
    BAL
  );
  return { dtA, dtB, protoA, protoB, keyA, keyB };
}

function encodedState(proto: QuantumPokerProtocol, state: PokerState): string {
  return toHex(proto.encodeState(state));
}

test("Quantum Poker distributed pair keeps shared hashes equal while holes stay local", () => {
  const { dtA, dtB, protoA, protoB } = makePair();
  const driverA = new QuantumPokerSeatDriver("A");
  const driverB = new QuantumPokerSeatDriver("B");
  const rng = mulberry32(12);
  let timestamp = 1n;
  let sawPrivateOpen = false;
  let sawHandResult = false;

  for (let steps = 0; steps < 400 && !sawHandResult; steps++) {
    let moved = false;
    for (const party of ["A", "B"] as Party[]) {
      const dt = party === "A" ? dtA : dtB;
      const driver = party === "A" ? driverA : driverB;
      const move = driver.chooseMove(dt.state, rng);
      if (!move) continue;

      dt.propose(move, timestamp++);
      moved = true;

      assert.equal(dtA.nonce, dtB.nonce);
      assert.equal(
        encodedState(protoA, dtA.state),
        encodedState(protoB, dtB.state)
      );
      assert.equal(
        protoA.balances(dtA.state).a + protoA.balances(dtA.state).b,
        20_000n
      );
      assert.equal(
        protoB.balances(dtB.state).a + protoB.balances(dtB.state).b,
        20_000n
      );

      if (dtA.state.phase === "preflop_bet") {
        sawPrivateOpen = true;
        assert.ok(driverA.knownHoleCards(dtA.state));
        assert.ok(driverB.knownHoleCards(dtB.state));
        assert.equal(dtA.state.holeB, null);
        assert.equal(dtB.state.holeA, null);
      }
      if (dtA.state.phase === "hand_over" && dtA.state.lastResult) {
        sawHandResult = true;
      }
      break;
    }
    assert.ok(moved, `expected a legal move at phase ${dtA.state.phase}`);
  }

  assert.ok(sawPrivateOpen, "expected private hole opening");
  assert.ok(sawHandResult, "expected one hand to resolve");
  assert.ok(dtA.latest && dtB.latest);
  assert.equal(toHex(dtA.latest!.sigA), toHex(dtB.latest!.sigA));
  assert.equal(toHex(dtA.latest!.sigB), toHex(dtB.latest!.sigB));
});

test("Quantum Poker distributed settlement signs transcript-root v2", () => {
  const { dtA, dtB, keyA, keyB } = makePair();
  const driverA = new QuantumPokerSeatDriver("A");
  const driverB = new QuantumPokerSeatDriver("B");
  const transcriptA = new Transcript(TUNNEL_ID);
  const transcriptB = new Transcript(TUNNEL_ID);
  dtA.onConfirmed = (u) => transcriptA.append(u);
  dtB.onConfirmed = (u) => transcriptB.append(u);
  const rng = mulberry32(99);
  let timestamp = 10n;

  for (let steps = 0; steps < 400 && dtA.state.phase !== "hand_over"; steps++) {
    let moved = false;
    for (const party of ["A", "B"] as Party[]) {
      const dt = party === "A" ? dtA : dtB;
      const driver = party === "A" ? driverA : driverB;
      const move = driver.chooseMove(dt.state, rng);
      if (!move) continue;
      dt.propose(move, timestamp++);
      moved = true;
      break;
    }
    assert.ok(moved, `expected a legal move at phase ${dtA.state.phase}`);
  }

  assert.equal(toHex(transcriptA.root()), toHex(transcriptB.root()));
  const halfA = dtA.buildSettlementHalfWithRoot(999n, transcriptA.root());
  const halfB = dtB.buildSettlementHalfWithRoot(999n, transcriptB.root());
  assert.deepEqual(halfA.settlement, halfB.settlement);

  const settled = dtA.combineSettlementWithRoot(
    halfA.settlement,
    halfA.sigSelf,
    halfB.sigSelf
  );
  const msg = serializeSettlementWithRoot(settled.settlement);
  assert.ok(verify(settled.sigA, msg, keyA.publicKey));
  assert.ok(verify(settled.sigB, msg, keyB.publicKey));
  assert.equal(settled.settlement.finalNonce, 1n);
  assert.equal(
    settled.settlement.partyABalance + settled.settlement.partyBBalance,
    20_000n
  );
});
