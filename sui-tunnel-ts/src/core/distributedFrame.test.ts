import test from "node:test";
import assert from "node:assert/strict";
import { bytesEqual } from "./bytes";
import {
  AckFrame,
  decodeFrame,
  encodeFrame,
  encodeRelayEnvelope,
  identityMoveCodec,
  MoveCodec,
  MoveFrame,
  wrapInnerFrameJson,
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
  const frame: AckFrame = {
    kind: "ack",
    nonce: 2n,
    sigResponder: new Uint8Array(64).fill(5),
  };
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

test("wrapInnerFrameJson stamps outer kind from a move inner JSON", () => {
  const innerJson = JSON.stringify({ kind: "move", nonce: "3", by: "A" });
  const env = JSON.parse(wrapInnerFrameJson(innerJson));
  assert.equal(env.t, "frame");
  assert.equal(env.kind, "move");
  assert.equal(env.data, innerJson);
});

test("wrapInnerFrameJson stamps outer kind from an ack inner JSON", () => {
  const innerJson = JSON.stringify({ kind: "ack", nonce: "5" });
  const env = JSON.parse(wrapInnerFrameJson(innerJson));
  assert.equal(env.t, "frame");
  assert.equal(env.kind, "ack");
  assert.equal(env.data, innerJson);
});

test("encodeRelayEnvelope delegates to wrapInnerFrameJson (move and ack)", () => {
  const moveFrame: MoveFrame<number> = {
    kind: "move",
    nonce: 3n,
    by: "A",
    move: 42,
    timestamp: 1750000000000n,
    stateHash: new Uint8Array(32).fill(1),
    partyABalance: 1000n,
    partyBBalance: 1000n,
    sigProposer: new Uint8Array(64).fill(2),
  };
  const moveEnv = JSON.parse(encodeRelayEnvelope(moveFrame, codec));
  assert.equal(moveEnv.t, "frame");
  assert.equal(moveEnv.kind, "move");
  assert.equal(typeof moveEnv.data, "string");

  const ackFrame: AckFrame = {
    kind: "ack",
    nonce: 3n,
    sigResponder: new Uint8Array(64).fill(5),
  };
  const ackEnv = JSON.parse(encodeRelayEnvelope(ackFrame, codec));
  assert.equal(ackEnv.t, "frame");
  assert.equal(ackEnv.kind, "ack");
  assert.equal(typeof ackEnv.data, "string");
});
