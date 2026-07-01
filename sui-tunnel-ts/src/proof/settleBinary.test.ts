import test from "node:test";
import assert from "node:assert/strict";
import { fromHex, toHex } from "../core/bytes";
import {
  encodeSettleBody,
  decodeSettleBody,
  decodeSettleEntries,
  SETTLE_BODY_VERSION,
} from "./settleBinary";

function rep(byte: number, n: number): Uint8Array {
  return new Uint8Array(n).fill(byte);
}

const INPUT = {
  tunnelId: "0x" + "00".repeat(31) + "01",
  partyABalance: 7n,
  partyBBalance: 3n,
  finalNonce: 5n,
  timestamp: 1234n,
  transcriptRoot: rep(0xaa, 32),
  sigA: rep(0x11, 64),
  sigB: rep(0x22, 64),
  entries: [
    { message: rep(0x33, 120), sigA: rep(0x44, 64), sigB: rep(0x55, 64) },
    { message: rep(0x66, 120), sigA: rep(0x77, 64), sigB: rep(0x88, 64) },
  ],
};

test("decodeSettleEntries parses the header-less entry run (chunk reassembly)", () => {
  // The streamed chunks are exactly the settle body's entry region — the body minus its 229B header.
  const entriesOnly = encodeSettleBody(INPUT).slice(229);
  const entries = decodeSettleEntries(entriesOnly);
  assert.equal(entries.length, INPUT.entries.length);
  assert.deepEqual(entries[0].message, INPUT.entries[0].message);
  assert.deepEqual(entries[1].sigB, INPUT.entries[1].sigB);
});

test("decodeSettleEntries rejects bytes that don't align to whole entries", () => {
  const truncated = encodeSettleBody(INPUT).slice(229).slice(0, -1);
  assert.throws(() => decodeSettleEntries(truncated));
});

test("encode→decode round-trips every field", () => {
  const decoded = decodeSettleBody(encodeSettleBody(INPUT));
  assert.equal(decoded.tunnelId, INPUT.tunnelId);
  assert.equal(decoded.partyABalance, INPUT.partyABalance);
  assert.equal(decoded.partyBBalance, INPUT.partyBBalance);
  assert.equal(decoded.finalNonce, INPUT.finalNonce);
  assert.equal(decoded.timestamp, INPUT.timestamp);
  assert.deepEqual(decoded.transcriptRoot, INPUT.transcriptRoot);
  assert.deepEqual(decoded.sigA, INPUT.sigA);
  assert.deepEqual(decoded.sigB, INPUT.sigB);
  assert.equal(decoded.entries.length, 2);
  assert.deepEqual(decoded.entries[1].message, INPUT.entries[1].message);
  assert.deepEqual(decoded.entries[1].sigB, INPUT.entries[1].sigB);
});

test("version byte is 0x01 and header layout is stable (GOLDEN)", () => {
  const bytes = encodeSettleBody(INPUT);
  assert.equal(bytes[0], SETTLE_BODY_VERSION);
  // header(229) + 2×(2 + 120 + 64 + 64) = 229 + 500 = 729 bytes
  assert.equal(bytes.length, 729);
  // PIN this once from the implementation's own output, then keep it identical
  // in Rust (routes.rs). If this assertion ever changes, the wire contract changed.
  const GOLDEN_HEX =
    "01000000000000000000000000000000000000000000000000000000000000000100000000000000070000000000000003000000000000000500000000000004d2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222000000020078333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444445555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555500786666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666667777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777788888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888";
  assert.equal(toHex(bytes), GOLDEN_HEX);
});

test("decode rejects a wrong version byte", () => {
  const bad = encodeSettleBody(INPUT);
  bad[0] = 0x02;
  assert.throws(() => decodeSettleBody(bad), /version/i);
});
