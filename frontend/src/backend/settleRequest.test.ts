import test from "node:test";
import assert from "node:assert/strict";
import { coSignedToSettleRequest } from "./settleRequest.ts";
// Relative .ts type import: tsx does not resolve the `sui-tunnel-ts/*` alias. `import type`
// is erased by esbuild, so this never hits the runtime resolver.
import type { CoSignedSettlementWithRoot } from "../../../sui-tunnel-ts/src/core/tunnel.ts";

// The serializer is the byte-shape boundary to the Rust backend: u64 fields (balances/nonce/
// timestamp) MUST become decimal strings and 32-byte values (root/sigs) MUST become lowercase
// hex with no 0x prefix (the backend's decode_hex trims an optional 0x; parse_u64 wants decimal).
// If this mapping drifts, settle 422s or the close verifies wrong — only money-at-stake reveals it.
test("coSignedToSettleRequest maps bigints to decimal strings and bytes to hex", () => {
  const coSigned: CoSignedSettlementWithRoot = {
    settlement: {
      tunnelId: "0x1",
      partyABalance: 1500n,
      partyBBalance: 500n,
      finalNonce: 1n,
      timestamp: 1_750_000_000_000n,
      transcriptRoot: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    },
    sigA: new Uint8Array([0xaa, 0xbb]),
    sigB: new Uint8Array([0x01, 0x02]),
  };
  const body = coSignedToSettleRequest(coSigned, []);
  assert.equal(body.settlement.tunnelId, "0x1");
  assert.equal(body.settlement.partyABalance, "1500");
  assert.equal(body.settlement.partyBBalance, "500");
  assert.equal(body.settlement.finalNonce, "1");
  assert.equal(body.settlement.timestamp, "1750000000000");
  assert.equal(body.settlement.transcriptRoot, "deadbeef");
  assert.equal(body.sigA, "aabb");
  assert.equal(body.sigB, "0102");
  assert.deepEqual(body.transcript, []);
});

test("coSignedToSettleRequest passes transcript entries through verbatim", () => {
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
  const entries = [{ nonce: "1", message: "00", sigA: "aa", sigB: "bb" }];
  const body = coSignedToSettleRequest(coSigned, entries);
  assert.equal(body.transcript.length, 1);
  assert.deepEqual(body.transcript[0], { nonce: "1", message: "00", sigA: "aa", sigB: "bb" });
  assert.equal(body.settlement.transcriptRoot, "00".repeat(32));
});
