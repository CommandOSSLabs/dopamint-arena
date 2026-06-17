import test from "node:test";
import assert from "node:assert/strict";
import { bytesEqual } from "./bytes";
import { generateKeyPair, KeyPair } from "./crypto";
import { defaultBackend } from "./crypto-native";
import { makeEndpoint, PartyEndpoint } from "./tunnel";
import { Balances, otherParty, Party, Protocol } from "../protocol/Protocol";
import { u64ToBeBytes } from "./wire";
import { Transport } from "./distributedTunnel";
import { DistributedTunnel } from "./distributedTunnel";

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
