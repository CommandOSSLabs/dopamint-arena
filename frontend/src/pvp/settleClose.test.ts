import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { bytesToHex } from "sui-tunnel-ts";
import { coSignCloseFromPeerRoot } from "./settleClose";

const BAL = { a: 1000n, b: 1000n };
const proto = {
  name: "settle-close-test",
  initialState: () => ({}),
  applyMove: (s: unknown) => s,
  encodeState: () => new Uint8Array(),
  balances: () => BAL,
  isTerminal: () => false,
} as never;

const noopTransport = { send: () => {}, onFrame: () => {} };

/** A seat-A + seat-B pair whose settlement builders sign over the shared tunnel state. */
function pair() {
  const backend = defaultBackend();
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const dtA = new DistributedTunnel(
    proto,
    {
      tunnelId: "0x7",
      self: makeEndpoint(backend, "0xa", keyA, true),
      opponent: makeEndpoint(backend, "0xb", keyB, false),
      selfParty: "A",
    },
    noopTransport,
    BAL,
  );
  const dtB = new DistributedTunnel(
    proto,
    {
      tunnelId: "0x7",
      self: makeEndpoint(backend, "0xb", keyB, true),
      opponent: makeEndpoint(backend, "0xa", keyA, false),
      selfParty: "B",
    },
    noopTransport,
    BAL,
  );
  return { dtA, dtB };
}

// The whole point of "FE trusts the bot's transcript": seat A never computes a root of its own — it
// signs its half over the root the peer (bot) supplied, and the co-signed close anchors THAT root.
test("co-signs the close over the peer's root, not a self-computed one", () => {
  const { dtA, dtB } = pair();
  const peerRoot = new Uint8Array(32).fill(7);
  const peerHalf = dtB.buildSettlementHalfWithRoot(9n, peerRoot, 0n);

  const co = coSignCloseFromPeerRoot(dtA, 9n, peerRoot, peerHalf.sigSelf);

  assert.equal(bytesToHex(co.settlement.transcriptRoot), bytesToHex(peerRoot));
});

// combine must verify the peer's signature — a forged/mismatched half cannot produce a close.
test("rejects a peer half whose signature does not verify", () => {
  const { dtA } = pair();
  const peerRoot = new Uint8Array(32).fill(7);
  const badSig = new Uint8Array(64).fill(1);

  assert.throws(() => coSignCloseFromPeerRoot(dtA, 9n, peerRoot, badSig));
});
