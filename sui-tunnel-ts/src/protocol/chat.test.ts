import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "../core/bytes";
import { ed25519Address, generateKeyPair } from "../core/crypto";
import { OffchainTunnel, verifyCoSignedUpdate } from "../core/tunnel";
import { ChatProtocol, ChatState } from "./chat";

const proto = new ChatProtocol();
const ctx = { tunnelId: "0xab", initialBalances: { a: 100n, b: 100n } };

test("initialState has zero digest, no messages, and locked balances", () => {
  const s = proto.initialState(ctx);
  assert.equal(s.messageCount, 0n);
  assert.equal(s.lastSender, null);
  assert.equal(s.balanceA, 100n);
  assert.equal(s.balanceB, 100n);
  assert.equal(s.total, 200n);
  assert.equal(s.transcriptDigest.length, 32);
  assert.equal(toHex(s.transcriptDigest), "00".repeat(32));
});

test("applyMove folds the digest, bumps count, tracks lastSender", () => {
  let s = proto.initialState(ctx);
  s = proto.applyMove(s, { kind: "msg", text: "hello" }, "A");
  assert.equal(s.messageCount, 1n);
  assert.equal(s.lastSender, "A");
  assert.notEqual(toHex(s.transcriptDigest), "00".repeat(32));
  // Plain messages leave balances untouched.
  assert.equal(s.balanceA, 100n);
  assert.equal(s.balanceB, 100n);
  const prevDigest = toHex(s.transcriptDigest);
  s = proto.applyMove(s, { kind: "msg", text: "world" }, "B");
  assert.equal(s.messageCount, 2n);
  assert.equal(s.lastSender, "B");
  assert.notEqual(toHex(s.transcriptDigest), prevDigest);
});

test("digest is order- and sender-sensitive", () => {
  const s = proto.initialState(ctx);
  const ab = proto.applyMove(s, { kind: "msg", text: "x" }, "A");
  const ba = proto.applyMove(s, { kind: "msg", text: "x" }, "B");
  // same text, different sender -> different digest
  assert.notEqual(toHex(ab.transcriptDigest), toHex(ba.transcriptDigest));
  // same first message, different second -> different digest (order matters)
  const ab1 = proto.applyMove(ab, { kind: "msg", text: "y" }, "B");
  const ab2 = proto.applyMove(ab, { kind: "msg", text: "z" }, "B");
  assert.notEqual(toHex(ab1.transcriptDigest), toHex(ab2.transcriptDigest));
});

test("tip shifts value and conserves total", () => {
  let s = proto.initialState(ctx);
  s = proto.applyMove(s, { kind: "msg", text: "thanks", tip: 30n }, "A");
  assert.equal(s.balanceA, 70n);
  assert.equal(s.balanceB, 130n);
  assert.equal(s.balanceA + s.balanceB, 200n);
  s = proto.applyMove(s, { kind: "msg", text: "back", tip: 10n }, "B");
  assert.equal(s.balanceA, 80n);
  assert.equal(s.balanceB, 120n);
  assert.equal(s.balanceA + s.balanceB, 200n);
});

test("tip of zero or undefined leaves balances unchanged but still counts", () => {
  let s = proto.initialState(ctx);
  s = proto.applyMove(s, { kind: "msg", text: "a", tip: 0n }, "A");
  assert.equal(s.balanceA, 100n);
  assert.equal(s.balanceB, 100n);
  assert.equal(s.messageCount, 1n);
});

test("applyMove rejects empty text and over-balance / negative tips", () => {
  const s = proto.initialState(ctx);
  assert.throws(() => proto.applyMove(s, { kind: "msg", text: "" }, "A"));
  assert.throws(() =>
    proto.applyMove(s, { kind: "msg", text: "hi", tip: 101n }, "A")
  );
  assert.throws(() =>
    proto.applyMove(s, { kind: "msg", text: "hi", tip: -1n }, "A")
  );
});

test("applyMove is pure (does not mutate input state)", () => {
  const s = proto.initialState(ctx);
  const before = toHex(s.transcriptDigest);
  proto.applyMove(s, { kind: "msg", text: "hello", tip: 5n }, "A");
  assert.equal(s.messageCount, 0n);
  assert.equal(s.balanceA, 100n);
  assert.equal(s.balanceB, 100n);
  assert.equal(toHex(s.transcriptDigest), before);
});

test("encodeState is deterministic, fixed-size, and changes with state", () => {
  const s0 = proto.initialState(ctx);
  const s1 = proto.applyMove(s0, { kind: "msg", text: "hi" }, "A");
  const e0 = proto.encodeState(s0);
  const e1 = proto.encodeState(s1);
  assert.equal(toHex(e0), toHex(proto.encodeState(s0)));
  assert.notEqual(toHex(e0), toHex(e1));
  // Fixed size: independent of message length / count.
  const longMsg = proto.applyMove(
    s1,
    {
      kind: "msg",
      text: "x".repeat(5000),
    },
    "B"
  );
  assert.equal(e1.length, proto.encodeState(longMsg).length);
});

test("balances sum to total and stay non-negative over a random sequence", () => {
  let s = proto.initialState(ctx);
  let x = 0.1234;
  const rng = () => (x = (x * 16807) % 1);
  for (let i = 0; i < 200; i++) {
    const by = i % 2 === 0 ? "A" : "B";
    const m = proto.randomMove(s, by, rng);
    s = proto.applyMove(s, m, by);
    const bal = proto.balances(s);
    assert.equal(bal.a + bal.b, 200n);
    assert.ok(bal.a >= 0n && bal.b >= 0n);
  }
  assert.equal(s.messageCount, 200n);
  assert.ok(!proto.isTerminal());
});

test("end-to-end self-play tunnel: latest co-signed update verifies", () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const t = OffchainTunnel.selfPlay(
    new ChatProtocol(),
    "0x" + "33".repeat(32),
    a,
    b,
    ed25519Address(a.publicKey),
    ed25519Address(b.publicKey),
    { a: 1000n, b: 1000n }
  );
  t.step({ kind: "msg", text: "gm" }, "A");
  t.step({ kind: "msg", text: "thanks", tip: 50n }, "B");
  t.step({ kind: "msg", text: "np" }, "A");
  t.step({ kind: "msg", text: "tipping back", tip: 20n }, "A");

  const s = t.state as ChatState;
  assert.equal(s.messageCount, 4n);
  assert.equal(s.balanceA + s.balanceB, 2000n);
  assert.equal(s.balanceA, 1000n - 20n + 50n);
  assert.equal(s.balanceB, 1000n + 20n - 50n);

  assert.ok(t.latest);
  assert.ok(
    verifyCoSignedUpdate(
      t.latest!,
      { publicKey: t.partyA.publicKey, scheme: t.partyA.scheme },
      { publicKey: t.partyB.publicKey, scheme: t.partyB.scheme }
    )
  );
});
