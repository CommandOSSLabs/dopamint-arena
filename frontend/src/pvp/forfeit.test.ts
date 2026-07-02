import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { serializeSettlementWithRoot } from "sui-tunnel-ts/core/wire";
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
