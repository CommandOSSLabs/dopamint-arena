import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { serializeSettlementWithRoot } from "sui-tunnel-ts/core/wire";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { buildForfeitHalf } from "./forfeit.ts";

test("buildForfeitHalf forces human=0, bot=total and self-verifies", () => {
  const eph = generateKeyPair();
  const wallet =
    "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const total = 200n;
  const root = new Uint8Array(32).fill(7);
  const { settlement, sig } = buildForfeitHalf({
    tunnelId: "0x" + "00".repeat(31) + "01",
    total,
    wallet,
    eph,
    timestamp: 42n,
    transcriptRoot: root,
  });
  assert.equal(settlement.partyABalance, 0n);
  assert.equal(settlement.partyBBalance, total);
  assert.equal(settlement.finalNonce, 1n);
  assert.equal(settlement.timestamp, 42n);
  // Signature verifies over the canonical bytes with the same eph key.
  const ep = makeEndpoint(defaultBackend(), wallet, eph, true);
  assert.ok(ep.verify(serializeSettlementWithRoot(settlement), sig));
});

// Cross-language golden: the forced (partyA=0, partyB=total) forfeit split serializes to a fixed
// hex, independently pinned on the Rust side (arena_anchor.rs::forfeit_settlement_matches_ts_golden)
// against the SAME literal. Both sides call the shared canonical serializer
// (serializeSettlementWithRoot / serialize_settlement_with_root), which is already byte-parity-pinned
// generically (wire.test.ts / wire.rs); this case just locks the forfeit-shaped inputs so a future
// change to either side's field order/width is caught without needing new golden infra.
test("forfeit settlement (partyA=0, partyB=total) matches the Rust golden", () => {
  const bytes = serializeSettlementWithRoot({
    tunnelId: "0xab",
    partyABalance: 0n,
    partyBBalance: 2000n,
    finalNonce: 1n,
    timestamp: 42n,
    transcriptRoot: new Uint8Array(32).fill(9),
  });
  assert.equal(bytes.length, 121);
  assert.equal(
    toHex(bytes),
    "7375695f74756e6e656c3a3a736574746c656d656e745f763200000000000000000000000000000000000000000000000000000000000000ab000000000000000000000000000007d00000000000000001000000000000002a0909090909090909090909090909090909090909090909090909090909090909",
  );
});

test("buildForfeitHalf rejects a non-32-byte root", () => {
  const eph = generateKeyPair();
  assert.throws(() =>
    buildForfeitHalf({
      tunnelId: "0x" + "00".repeat(31) + "02",
      total: 2n,
      wallet:
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      eph,
      timestamp: 1n,
      transcriptRoot: new Uint8Array(31),
    }),
  );
});
