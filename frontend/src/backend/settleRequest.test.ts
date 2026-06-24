import test from "node:test";
import assert from "node:assert/strict";
import { coSignedToSettleBody } from "./settleRequest.ts";
// Relative .ts imports: tsx does not resolve the `sui-tunnel-ts/*` alias. `import type` is
// erased by esbuild; the value import (decodeSettleBody) is the round-trip oracle.
import { decodeSettleBody } from "../../../sui-tunnel-ts/src/proof/settleBinary.ts";
import type { CoSignedSettlementWithRoot } from "../../../sui-tunnel-ts/src/core/tunnel.ts";
import type { TranscriptEntry } from "../../../sui-tunnel-ts/src/proof/transcript.ts";

// The encoder is the byte-shape boundary to the Rust backend: the co-signed settlement +
// raw transcript entries must round-trip through decodeSettleBody unchanged. If the field
// mapping drifts, settle 422s or the close verifies wrong — only money-at-stake reveals it.
test("coSignedToSettleBody emits a body that decodes to the settlement + entries", () => {
  const coSigned: CoSignedSettlementWithRoot = {
    settlement: {
      tunnelId: "0x" + "00".repeat(31) + "01",
      partyABalance: 1500n,
      partyBBalance: 500n,
      finalNonce: 1n,
      timestamp: 1_750_000_000_000n,
      transcriptRoot: new Uint8Array(32).fill(0xaa),
    },
    sigA: new Uint8Array(64).fill(0x11),
    sigB: new Uint8Array(64).fill(0x22),
  };
  const entries: TranscriptEntry[] = [
    {
      nonce: 1n,
      message: new Uint8Array(120).fill(0x33),
      sigA: new Uint8Array(64).fill(0x44),
      sigB: new Uint8Array(64).fill(0x55),
    },
  ];

  const body = coSignedToSettleBody(coSigned, entries);
  const d = decodeSettleBody(body);

  assert.equal(d.tunnelId, coSigned.settlement.tunnelId);
  assert.equal(d.partyABalance, coSigned.settlement.partyABalance);
  assert.equal(d.partyBBalance, coSigned.settlement.partyBBalance);
  assert.equal(d.finalNonce, coSigned.settlement.finalNonce);
  assert.equal(d.timestamp, coSigned.settlement.timestamp);
  assert.deepEqual(d.transcriptRoot, coSigned.settlement.transcriptRoot);
  assert.deepEqual(d.sigA, coSigned.sigA);
  assert.deepEqual(d.sigB, coSigned.sigB);
  assert.equal(d.entries.length, 1);
  assert.deepEqual(d.entries[0].message, entries[0].message);
  assert.deepEqual(d.entries[0].sigA, entries[0].sigA);
  assert.deepEqual(d.entries[0].sigB, entries[0].sigB);
});

test("coSignedToSettleBody encodes an empty transcript (count 0)", () => {
  const coSigned: CoSignedSettlementWithRoot = {
    settlement: {
      tunnelId: "0x1",
      partyABalance: 0n,
      partyBBalance: 2000n,
      finalNonce: 1n,
      timestamp: 1n,
      transcriptRoot: new Uint8Array(32),
    },
    sigA: new Uint8Array(64),
    sigB: new Uint8Array(64),
  };
  const d = decodeSettleBody(coSignedToSettleBody(coSigned, []));
  assert.equal(d.entries.length, 0);
  assert.equal(d.partyBBalance, 2000n);
});
