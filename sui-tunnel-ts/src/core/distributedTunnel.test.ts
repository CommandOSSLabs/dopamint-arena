import test from "node:test";
import assert from "node:assert/strict";
import { bytesEqual } from "./bytes";
import { blake2b256, generateKeyPair, KeyPair, sign as edSign } from "./crypto";
import { defaultBackend } from "./crypto-native";
import { makeEndpoint, OffchainTunnel, PartyEndpoint } from "./tunnel";
import { Balances, otherParty, Party, Protocol } from "../protocol/Protocol";
import { serializeStateUpdate, u64ToBeBytes } from "./wire";
import { Transport } from "./distributedTunnel";
import { DistributedTunnel } from "./distributedTunnel";
import { encodeFrame, identityMoveCodec, MoveFrame } from "./distributedFrame";

// ---- shared test fixtures ----

/** Turn-enforcing stand-in for a real game: A and B alternate; balances are fixed. */
interface CounterState {
  count: number;
  turn: Party;
}
const BAL: Balances = { a: 1000n, b: 1000n };
const counterProtocol: Protocol<CounterState, number> = {
  name: "counter-test",
  initialState: () => ({ count: 0, turn: "A" }),
  applyMove(state, _move, by) {
    if (by !== state.turn) throw new Error(`out of turn: ${by} != ${state.turn}`);
    return { count: state.count + 1, turn: otherParty(by) };
  },
  encodeState: (s) => u64ToBeBytes(BigInt(s.count)),
  balances: () => BAL,
  isTerminal: (s) => s.count >= 4,
};

/** Two transports wired so a.send delivers to b's handler and vice-versa (synchronous). */
export function makeLoopback(): { a: Transport; b: Transport } {
  let aCb: ((f: Uint8Array) => void) | null = null;
  let bCb: ((f: Uint8Array) => void) | null = null;
  return {
    a: { send: (f) => bCb?.(f), onFrame: (cb) => { aCb = cb; } },
    b: { send: (f) => aCb?.(f), onFrame: (cb) => { bCb = cb; } },
  };
}

function makeManual(): { transport: Transport; deliver: (b: Uint8Array) => void; sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  let cb: ((f: Uint8Array) => void) | null = null;
  return {
    transport: { send: (f) => { sent.push(f); }, onFrame: (c) => { cb = c; } },
    deliver: (b) => cb?.(b),
    sent,
  };
}

const backend = defaultBackend();
function endpoints(keyA: KeyPair, keyB: KeyPair, addrA: string, addrB: string) {
  // For seat A: self=A (signs), opponent=B (verify-only). Mirror for seat B.
  const aSelf = makeEndpoint(backend, addrA, keyA, true);
  const aOpp = makeEndpoint(backend, addrB, keyB, false);
  const bSelf = makeEndpoint(backend, addrB, keyB, true);
  const bOpp = makeEndpoint(backend, addrA, keyA, false);
  return { aSelf, aOpp, bSelf, bOpp };
}

function makePair(loop = makeLoopback()) {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const addrA = "0xa11ce";
  const addrB = "0xb0b";
  const e = endpoints(keyA, keyB, addrA, addrB);
  const dtA = new DistributedTunnel(
    counterProtocol,
    { tunnelId: "0x7", self: e.aSelf, opponent: e.aOpp, selfParty: "A" as Party },
    loop.a,
    BAL,
  );
  const dtB = new DistributedTunnel(
    counterProtocol,
    { tunnelId: "0x7", self: e.bSelf, opponent: e.bOpp, selfParty: "B" as Party },
    loop.b,
    BAL,
  );
  return { dtA, dtB, keyA, keyB, addrA, addrB };
}

// ---- tests ----

test("one full move exchange advances both sides to the same co-signed update", () => {
  const { dtA, dtB } = makePair();
  dtA.propose(1, 100n); // A's turn; synchronous loopback completes the MOVE->ACK round-trip
  assert.equal(dtA.nonce, 1n);
  assert.equal(dtB.nonce, 1n);
  assert.ok(dtA.latest && dtB.latest, "both have a latest co-signed update");
  assert.equal(dtA.latest!.update.nonce, 1n);
  assert.ok(bytesEqual(dtA.latest!.sigA, dtB.latest!.sigA), "sigA matches across seats");
  assert.ok(bytesEqual(dtA.latest!.sigB, dtB.latest!.sigB), "sigB matches across seats");
});

test("proposing out of turn throws (protocol enforces turn order)", () => {
  const { dtB } = makePair();
  // It is A's turn at nonce 1; B proposing must throw via applyMove.
  assert.throws(() => dtB.propose(1, 100n), /out of turn/);
});

test("a second proposal before ACK is rejected", () => {
  const { dtA } = makePair(
    // manual transport: capture sends, never auto-deliver, so no ACK arrives
    (() => {
      const sent: Uint8Array[] = [];
      let cb: ((f: Uint8Array) => void) | null = null;
      const t: Transport = { send: (f) => { sent.push(f); }, onFrame: (c) => { cb = c; } };
      return { a: t, b: t }; // a===b: only dtA is built from this; no delivery happens
    })(),
  );
  dtA.propose(1, 100n);
  assert.throws(() => dtA.propose(1, 100n), /already awaiting ACK/);
});

test("DistributedTunnel pair matches OffchainTunnel.selfPlay byte-for-byte", () => {
  const { dtA, dtB, keyA, keyB, addrA, addrB } = makePair();
  const self = OffchainTunnel.selfPlay(
    counterProtocol,
    "0x7",
    keyA,
    keyB,
    addrA,
    addrB,
    BAL,
  );

  // Alternate A,B,A,B with matching timestamps on both engines.
  const seq: Array<{ by: Party; ts: bigint }> = [
    { by: "A", ts: 11n },
    { by: "B", ts: 22n },
    { by: "A", ts: 33n },
    { by: "B", ts: 44n },
  ];
  for (const { by, ts } of seq) {
    self.step(0, by, { timestamp: ts, mode: "full" });
    if (by === "A") dtA.propose(0, ts);
    else dtB.propose(0, ts);
  }

  for (const dt of [dtA, dtB]) {
    assert.equal(dt.latest!.update.nonce, self.latest!.update.nonce);
    assert.ok(bytesEqual(dt.latest!.sigA, self.latest!.sigA), "sigA parity");
    assert.ok(bytesEqual(dt.latest!.sigB, self.latest!.sigB), "sigB parity");
  }

  // Settlement parity: each seat signs its half; combine; compare to self-play.
  const selfSettle = self.buildSettlement(99n);
  const halfA = dtA.buildSettlementHalf(99n);
  const halfB = dtB.buildSettlementHalf(99n);
  const combined = dtA.combineSettlement(halfA.settlement, halfA.sigSelf, halfB.sigSelf);
  assert.ok(bytesEqual(combined.sigA, selfSettle.sigA), "settlement sigA parity");
  assert.ok(bytesEqual(combined.sigB, selfSettle.sigB), "settlement sigB parity");
  assert.equal(combined.settlement.finalNonce, selfSettle.settlement.finalNonce);
});

// The ADR's load-bearing claim: address is NEVER in the signed bytes. Same keys +
// different addresses MUST yield byte-identical signatures. If a future edit folds
// address into the signed message, this is the test that breaks.
test("co-signed sigs are independent of party address", () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const t1 = OffchainTunnel.selfPlay(counterProtocol, "0x7", keyA, keyB, "0xAAAA", "0xBBBB", BAL);
  const t2 = OffchainTunnel.selfPlay(counterProtocol, "0x7", keyA, keyB, "0xdead", "0xbeef", BAL);
  t1.step(0, "A", { timestamp: 1n, mode: "full" });
  t2.step(0, "A", { timestamp: 1n, mode: "full" });
  assert.ok(bytesEqual(t1.latest!.sigA, t2.latest!.sigA), "sigA independent of address");
  assert.ok(bytesEqual(t1.latest!.sigB, t2.latest!.sigB), "sigB independent of address");
});

test("receiver rejects a MOVE whose stateHash != re-derived hash", () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const e = endpoints(keyA, keyB, "0xa11ce", "0xb0b");
  const m = makeManual();
  const dtB = new DistributedTunnel(
    counterProtocol,
    { tunnelId: "0x7", self: e.bSelf, opponent: e.bOpp, selfParty: "B" as Party },
    m.transport,
    BAL,
  );
  // Craft a MOVE A would send, but tamper the stateHash. A signs the (tampered) bytes
  // so the signature is valid — only the re-apply check catches it.
  const badHash = new Uint8Array(32).fill(0xff);
  const update = {
    tunnelId: "0x7",
    stateHash: badHash,
    nonce: 1n,
    timestamp: 100n,
    partyABalance: 1000n,
    partyBBalance: 1000n,
  };
  const msg = serializeStateUpdate(update);
  const frame: MoveFrame<number> = {
    kind: "move",
    nonce: 1n,
    by: "A",
    move: 0,
    timestamp: 100n,
    stateHash: badHash,
    partyABalance: 1000n,
    partyBBalance: 1000n,
    sigProposer: edSign(msg, keyA.secretKey),
  };
  assert.throws(() => m.deliver(encodeFrame(frame, identityMoveCodec)), /stateHash/);
  assert.equal(dtB.nonce, 0n, "rejected MOVE must not advance state");
});

// `displayState` is what the UI renders: the locally-applied, already-signed pending move
// shown immediately, so the proposer's own move never waits a co-sign round-trip to appear.
// Confirmed `state` (the settlement/security source of truth) must stay put until the ACK.
test("displayState reflects a proposed move before the ACK; confirmed state does not", () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const e = endpoints(keyA, keyB, "0xa11ce", "0xb0b");
  const m = makeManual();
  const dtA = new DistributedTunnel(
    counterProtocol,
    { tunnelId: "0x7", self: e.aSelf, opponent: e.aOpp, selfParty: "A" as Party },
    m.transport,
    BAL,
  );
  dtA.propose(0, 100n);
  assert.equal(dtA.nonce, 0n, "confirmed state must not advance before ACK");
  assert.equal((dtA.state as CounterState).count, 0, "confirmed state unchanged");
  assert.equal((dtA.displayState as CounterState).count, 1, "display state shows the pending move");
  assert.equal((dtA.displayState as CounterState).turn, "B", "display state flips the turn");
});

test("displayState collapses to confirmed state once the ACK lands", () => {
  const { dtA } = makePair(); // synchronous loopback completes MOVE->ACK
  dtA.propose(1, 100n);
  assert.equal(dtA.nonce, 1n, "confirmed after ACK");
  assert.strictEqual(dtA.displayState, dtA.state, "no pending → displayState === confirmed state");
});

test("proposer advances only on a valid ACK", () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const e = endpoints(keyA, keyB, "0xa11ce", "0xb0b");
  const m = makeManual();
  const dtA = new DistributedTunnel(
    counterProtocol,
    { tunnelId: "0x7", self: e.aSelf, opponent: e.aOpp, selfParty: "A" as Party },
    m.transport,
    BAL,
  );
  dtA.propose(0, 100n);
  assert.equal(dtA.nonce, 0n, "no advance before ACK");
  assert.equal(dtA.latest, null);

  // Reconstruct the exact signed message A produced, sign B's half, deliver the ACK.
  const update = {
    tunnelId: "0x7",
    stateHash: blakeOfCount1(),
    nonce: 1n,
    timestamp: 100n,
    partyABalance: 1000n,
    partyBBalance: 1000n,
  };
  const sigB = edSign(serializeStateUpdate(update), keyB.secretKey);
  m.deliver(encodeFrame({ kind: "ack", nonce: 1n, sigResponder: sigB }, identityMoveCodec));
  assert.equal(dtA.nonce, 1n, "valid ACK advances");
  assert.ok(bytesEqual(dtA.latest!.sigB, sigB));
});

// Helper: blake2b256 of the count=1 encodeState, matching counterProtocol.
function blakeOfCount1(): Uint8Array {
  return blake2b256(counterProtocol.encodeState({ count: 1, turn: "B" }));
}

test("engine pair over a relay-shaped transport reaches a settleable terminal state", () => {
  // A transport that mimics the backend relay: send() routes to the OTHER seat verbatim.
  const { dtA, dtB } = makePair();
  // Drive a full 4-move game; loopback already routes to the other seat.
  const seq: Array<{ by: Party; ts: bigint }> = [
    { by: "A", ts: 1n },
    { by: "B", ts: 2n },
    { by: "A", ts: 3n },
    { by: "B", ts: 4n },
  ];
  for (const { by, ts } of seq) (by === "A" ? dtA : dtB).propose(0, ts);

  assert.equal(dtA.nonce, 4n);
  assert.ok(counterProtocol.isTerminal(dtA.state as any), "terminal after 4 moves");

  const halfA = dtA.buildSettlementHalf(5n);
  const halfB = dtB.buildSettlementHalf(5n);
  const settled = dtA.combineSettlement(halfA.settlement, halfA.sigSelf, halfB.sigSelf);

  // Shape matches the backend SettleRequest.settlement (balances/nonce as strings on the wire).
  assert.equal(settled.settlement.finalNonce, 1n); // onchainNonce(0) + 1
  assert.equal(settled.settlement.partyABalance + settled.settlement.partyBBalance, 2000n);
  assert.equal(settled.sigA.length, 64);
  assert.equal(settled.sigB.length, 64);
});

test("with-root settlement: both halves combine and preserve the anchored root", () => {
  const { dtA, dtB } = makePair();
  // advance two moves so state/balances are non-trivial
  dtA.propose(0, 1n);
  dtB.propose(0, 2n);
  const root = new Uint8Array(32).fill(7);
  const halfA = dtA.buildSettlementHalfWithRoot(9n, root, 0n);
  const halfB = dtB.buildSettlementHalfWithRoot(9n, root, 0n);
  const co = dtA.combineSettlementWithRoot(halfA.settlement, halfA.sigSelf, halfB.sigSelf);
  assert.ok(bytesEqual(co.settlement.transcriptRoot, root), "anchored root preserved");
  assert.equal(co.settlement.finalNonce, 1n); // onchainNonce(0) + 1
  assert.equal(co.sigA.length, 64);
  assert.equal(co.sigB.length, 64);
});

// The load-bearing parity: a distributed with-root settlement must be byte-identical to the
// self-play one the contract already accepts. If these signatures diverge, the PvP close
// verifies off-chain but FAILS at close_cooperative_with_root — a money-at-stake bug.
test("with-root halves match OffchainTunnel.buildSettlementWithRoot byte-for-byte", () => {
  const { dtA, dtB, keyA, keyB, addrA, addrB } = makePair();
  const self = OffchainTunnel.selfPlay(counterProtocol, "0x7", keyA, keyB, addrA, addrB, BAL);
  const seq: Array<{ by: Party; ts: bigint }> = [
    { by: "A", ts: 11n },
    { by: "B", ts: 22n },
  ];
  for (const { by, ts } of seq) {
    self.step(0, by, { timestamp: ts, mode: "full" });
    (by === "A" ? dtA : dtB).propose(0, ts);
  }
  const root = new Uint8Array(32).fill(3);
  const selfSettle = self.buildSettlementWithRoot(99n, root);
  const halfA = dtA.buildSettlementHalfWithRoot(99n, root);
  const halfB = dtB.buildSettlementHalfWithRoot(99n, root);
  const combined = dtA.combineSettlementWithRoot(halfA.settlement, halfA.sigSelf, halfB.sigSelf);
  assert.ok(bytesEqual(combined.sigA, selfSettle.sigA), "with-root sigA parity");
  assert.ok(bytesEqual(combined.sigB, selfSettle.sigB), "with-root sigB parity");
  assert.ok(bytesEqual(combined.settlement.transcriptRoot, selfSettle.settlement.transcriptRoot));
});

test("combineSettlementWithRoot rejects a bad opponent signature", () => {
  const { dtA, dtB } = makePair();
  dtA.propose(0, 1n);
  const root = new Uint8Array(32).fill(5);
  const halfA = dtA.buildSettlementHalfWithRoot(9n, root);
  void dtB.buildSettlementHalfWithRoot(9n, root);
  const bogus = new Uint8Array(64).fill(9);
  assert.throws(
    () => dtA.combineSettlementWithRoot(halfA.settlement, halfA.sigSelf, bogus),
    /signature failed verification/,
  );
});
