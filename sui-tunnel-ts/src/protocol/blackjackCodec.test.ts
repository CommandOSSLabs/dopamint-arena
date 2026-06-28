import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCommitment } from "../core/commitment";
import { generateKeyPair } from "../core/crypto";
import { defaultBackend } from "../core/crypto-native";
import { DistributedTunnel } from "../core/distributedTunnel";
import { makeEndpoint } from "../core/tunnel";
import {
  BlackjackMove,
  BlackjackProtocol,
  secureBlackjackSecret,
} from "./blackjack";
import { blackjackMoveCodec } from "./blackjackCodec";

test("commit encoding DROPS the pre-image (no value/salt/localSecret on the wire)", () => {
  const s = secureBlackjackSecret();
  const move: BlackjackMove = {
    kind: "commit",
    commitment: computeCommitment(s.value, s.salt),
    localSecret: s,
  };
  const json = blackjackMoveCodec.encode(move);
  const text = JSON.stringify(json);
  assert.ok(!text.includes("localSecret"), "localSecret leaked");
  assert.ok(!text.includes("salt"), "salt leaked");
  assert.ok(!text.includes("value"), "value leaked");
  const decoded = blackjackMoveCodec.decode(json) as Extract<
    BlackjackMove,
    { kind: "commit" }
  >;
  assert.equal(decoded.kind, "commit");
  assert.equal(decoded.commitment.length, 32);
  assert.equal((decoded as { localSecret?: unknown }).localSecret, undefined);
});

test("reveal / deal / hit / stand / forfeit round-trip", () => {
  const reveal: BlackjackMove = {
    kind: "reveal",
    reveal: { value: Uint8Array.from([9]), salt: new Uint8Array(16).fill(3) },
  };
  const r = blackjackMoveCodec.decode(blackjackMoveCodec.encode(reveal)) as Extract<
    BlackjackMove,
    { kind: "reveal" }
  >;
  assert.deepEqual(Array.from(r.reveal.value), [9]);
  for (const m of [
    { kind: "deal" },
    { kind: "hit" },
    { kind: "stand" },
    { kind: "forfeit" },
  ] as BlackjackMove[]) {
    assert.deepEqual(blackjackMoveCodec.decode(blackjackMoveCodec.encode(m)), m);
  }
});

test("secureBlackjackSecret is 16-byte CSPRNG value+salt", () => {
  const s = secureBlackjackSecret();
  assert.equal(s.value.length, 16);
  assert.equal(s.salt.length, 16);
  const t = secureBlackjackSecret();
  // Astronomically unlikely to collide if it is real CSPRNG output.
  assert.notDeepEqual(Array.from(s.value), Array.from(t.value));
});

test("DistributedTunnel REFUSES a secret-bearing protocol without a moveCodec (fail closed)", () => {
  const backend = defaultBackend();
  const a = generateKeyPair();
  const b = generateKeyPair();
  const transport = { send() {}, onFrame() {} };
  const cfg = {
    tunnelId: "0x1",
    self: makeEndpoint(backend, "0xa", a, true),
    opponent: makeEndpoint(backend, "0xb", b, false),
    selfParty: "A" as const,
  };
  assert.throws(
    () =>
      new DistributedTunnel(new BlackjackProtocol(), cfg, transport, {
        a: 1000n,
        b: 1000n,
      }),
    /secret-bearing moves and requires an explicit moveCodec/,
  );
  // With the codec it constructs fine.
  assert.ok(
    new DistributedTunnel(
      new BlackjackProtocol(),
      { ...cfg, moveCodec: blackjackMoveCodec },
      transport,
      { a: 1000n, b: 1000n },
    ),
  );
});

test("decode rejects malformed commit/reveal frames with clear errors", () => {
  assert.throws(() => blackjackMoveCodec.decode({ kind: "nope" }), /unsupported/);
  assert.throws(
    () => blackjackMoveCodec.decode({ kind: "commit", commitment: "0x00" }),
    /32 bytes/,
  );
  assert.throws(() => blackjackMoveCodec.decode({ kind: "reveal" }), /must be an object/);
  assert.throws(
    () => blackjackMoveCodec.decode({ kind: "reveal", reveal: { salt: "0x01" } }),
    /reveal\.value must be a hex string/,
  );
});
