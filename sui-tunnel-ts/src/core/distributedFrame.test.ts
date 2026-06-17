import test from "node:test";
import assert from "node:assert/strict";
import { bytesEqual } from "./bytes";
import {
  AckFrame,
  decodeFrame,
  encodeFrame,
  identityMoveCodec,
  MoveCodec,
  MoveFrame,
} from "./distributedFrame";

const codec = identityMoveCodec as MoveCodec<number>;

test("MOVE frame round-trips through the opaque codec", () => {
  const frame: MoveFrame<number> = {
    kind: "move",
    nonce: 1n,
    by: "A",
    move: 7,
    timestamp: 1750000000000n,
    stateHash: new Uint8Array(32).fill(9),
    partyABalance: 1500n,
    partyBBalance: 500n,
    sigProposer: new Uint8Array(64).fill(3),
  };
  const decoded = decodeFrame<number>(encodeFrame(frame, codec), codec);
  assert.equal(decoded.kind, "move");
  if (decoded.kind !== "move") return;
  assert.equal(decoded.nonce, 1n);
  assert.equal(decoded.by, "A");
  assert.equal(decoded.move, 7);
  assert.equal(decoded.timestamp, 1750000000000n);
  assert.equal(decoded.partyABalance, 1500n);
  assert.equal(decoded.partyBBalance, 500n);
  assert.ok(bytesEqual(decoded.stateHash, frame.stateHash));
  assert.ok(bytesEqual(decoded.sigProposer, frame.sigProposer));
});

test("ACK frame round-trips", () => {
  const frame: AckFrame = { kind: "ack", nonce: 2n, sigResponder: new Uint8Array(64).fill(5) };
  const decoded = decodeFrame<number>(encodeFrame(frame, codec), codec);
  assert.equal(decoded.kind, "ack");
  if (decoded.kind !== "ack") return;
  assert.equal(decoded.nonce, 2n);
  assert.ok(bytesEqual(decoded.sigResponder, frame.sigResponder));
});

test("unknown frame kind throws on decode", () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ kind: "bogus" }));
  assert.throws(() => decodeFrame<number>(bytes, codec), /unknown frame kind/);
});
