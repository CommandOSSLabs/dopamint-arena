import { test } from "node:test";
import assert from "node:assert/strict";
import { blackjackMoveCodec } from "./blackjackCodec";
import type { BlackjackMove } from "./blackjack";

function rt(m: BlackjackMove): BlackjackMove {
  return blackjackMoveCodec.decode(blackjackMoveCodec.encode(m));
}

test("bet round-trips with its amount as a bigint", () => {
  const out = rt({ kind: "bet", amount: 250n });
  assert.deepEqual(out, { kind: "bet", amount: 250n });
});

test("commit round-trips its 32-byte commitment and DROPS localSecret from the wire", () => {
  const commitment = new Uint8Array(32).fill(7);
  const localSecret = { value: Uint8Array.from([9]), salt: new Uint8Array(16).fill(3) };
  const json = blackjackMoveCodec.encode({ kind: "commit", commitment, localSecret });
  // The wire form must not carry the secret.
  assert.equal(JSON.stringify(json).includes("salt"), false);
  const out = blackjackMoveCodec.decode(json) as Extract<BlackjackMove, { kind: "commit" }>;
  assert.equal(out.kind, "commit");
  assert.deepEqual(out.commitment, commitment);
  assert.equal(out.localSecret, undefined);
});

test("reveal round-trips value and salt bytes", () => {
  const reveal = { value: Uint8Array.from([1, 2, 3]), salt: new Uint8Array(16).fill(5) };
  const out = rt({ kind: "reveal", reveal }) as Extract<BlackjackMove, { kind: "reveal" }>;
  assert.deepEqual(out.reveal.value, reveal.value);
  assert.deepEqual(out.reveal.salt, reveal.salt);
});

test("bare moves round-trip", () => {
  assert.deepEqual(rt({ kind: "hit" }), { kind: "hit" });
  assert.deepEqual(rt({ kind: "stand" }), { kind: "stand" });
  assert.deepEqual(rt({ kind: "forfeit" }), { kind: "forfeit" });
});

test("a non-32-byte commitment is rejected on decode", () => {
  const json = { kind: "commit", commitment: "0x" + "07".repeat(16) };
  assert.throws(() => blackjackMoveCodec.decode(json), /32 bytes/);
});

test("an unknown move kind is rejected on decode", () => {
  assert.throws(() => blackjackMoveCodec.decode({ kind: "nope" }), /unsupported/);
});

test("JSON survives a stringify/parse trip (real relay path)", () => {
  const m: BlackjackMove = { kind: "reveal", reveal: { value: Uint8Array.from([4]), salt: new Uint8Array(16).fill(2) } };
  const wire = JSON.parse(JSON.stringify(blackjackMoveCodec.encode(m)));
  const out = blackjackMoveCodec.decode(wire) as Extract<BlackjackMove, { kind: "reveal" }>;
  assert.deepEqual(out.reveal.salt, (m as Extract<BlackjackMove, { kind: "reveal" }>).reveal.salt);
});
