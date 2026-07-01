import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "./bytes";
import {
  addressToBytes32,
  serializeHtlcLock,
  serializeRefereeAssignment,
  serializeSettlement,
  serializeSettlementWithRoot,
  serializeSpendAuthorization,
  serializeStateUpdate,
  StateUpdateWriter,
  u64ToBeBytes,
} from "./wire";

// Golden vectors shared with sui_tunnel/tests/wire_format_tests.move.
const G_STATE_UPDATE =
  "7375695f74756e6e656c3a3a73746174655f75706461746500000000000000000000000000000000000000000000000000000000000000ab0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20000000000000002a00000000499602d200000000000003e800000000000007d0";
const G_SETTLEMENT =
  "7375695f74756e6e656c3a3a736574746c656d656e7400000000000000000000000000000000000000000000000000000000000000ab00000000000003e800000000000007d0000000000000002b00000000499602d2";
const G_HTLC_LOCK =
  "7375695f74756e6e656c3a3a68746c635f6c6f636b00000000000000000000000000000000000000000000000000000000000000ab0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2000000000000001f400000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000bb000000000098967f";
// Shared with agent_allowance_tests::spend_authorization_wire_format.
const G_SPEND_AUTH =
  "7375695f74756e6e656c3a3a7370656e645f617574686f72697a6174696f6e00000000000000000000000000000000000000000000000000000000000000ab00000000000003e8";
// Shared with tunnel_tests::referee_assignment_wire_format (tunnel_id @0xab, referee @0xcd).
const G_REFEREE_ASSIGNMENT =
  "7375695f74756e6e656c3a3a726566657265655f61737369676e6d656e7400000000000000000000000000000000000000000000000000000000000000ab00000000000000000000000000000000000000000000000000000000000000cd";

const stateHash = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const paymentHash = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

test("serializeStateUpdate matches Move golden", () => {
  const bytes = serializeStateUpdate({
    tunnelId: "0xab",
    stateHash,
    nonce: 42n,
    timestamp: 1234567890n,
    partyABalance: 1000n,
    partyBBalance: 2000n,
  });
  assert.equal(bytes.length, 120);
  assert.equal(toHex(bytes), G_STATE_UPDATE);
});

test("serializeSettlement matches Move golden (note: different field order)", () => {
  const bytes = serializeSettlement({
    tunnelId: "0xab",
    partyABalance: 1000n,
    partyBBalance: 2000n,
    finalNonce: 43n,
    timestamp: 1234567890n,
  });
  assert.equal(bytes.length, 86);
  assert.equal(toHex(bytes), G_SETTLEMENT);
});

test("serializeSettlementWithRoot matches Move golden (settlement_v2)", () => {
  const bytes = serializeSettlementWithRoot({
    tunnelId: "0xab",
    partyABalance: 1000n,
    partyBBalance: 2000n,
    finalNonce: 43n,
    timestamp: 1234567890n,
    transcriptRoot: stateHash,
  });
  assert.equal(bytes.length, 121);
  assert.equal(
    toHex(bytes),
    "7375695f74756e6e656c3a3a736574746c656d656e745f763200000000000000000000000000000000000000000000000000000000000000ab00000000000003e800000000000007d0000000000000002b00000000499602d20102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
  );
  assert.throws(() =>
    serializeSettlementWithRoot({
      tunnelId: "0xab",
      partyABalance: 0n,
      partyBBalance: 0n,
      finalNonce: 0n,
      timestamp: 0n,
      transcriptRoot: new Uint8Array(31),
    })
  );
});

test("serializeHtlcLock matches Move golden", () => {
  const bytes = serializeHtlcLock({
    tunnelId: "0xab",
    paymentHash,
    amount: 500n,
    sender: "0xaa",
    receiver: "0xbb",
    expiryMs: 9999999n,
  });
  assert.equal(bytes.length, 165);
  assert.equal(toHex(bytes), G_HTLC_LOCK);
});

test("serializeSpendAuthorization matches Move golden", () => {
  const bytes = serializeSpendAuthorization({
    allowanceId: "0xab",
    authorizedTotal: 1000n,
  });
  assert.equal(bytes.length, 71);
  assert.equal(toHex(bytes), G_SPEND_AUTH);
});

test("serializeRefereeAssignment matches Move golden", () => {
  assert.equal(toHex(serializeRefereeAssignment("0xab", "0xcd")), G_REFEREE_ASSIGNMENT);
});

test("u64ToBeBytes is big-endian (NOT BCS little-endian)", () => {
  assert.equal(toHex(u64ToBeBytes(1n)), "0000000000000001");
  assert.equal(toHex(u64ToBeBytes(0x499602d2n)), "00000000499602d2");
  assert.equal(toHex(u64ToBeBytes((1n << 64n) - 1n)), "ffffffffffffffff");
});

test("u64ToBeBytes rejects out-of-range", () => {
  assert.throws(() => u64ToBeBytes(-1n));
  assert.throws(() => u64ToBeBytes(1n << 64n));
});

test("addressToBytes32 left-pads to 32 bytes", () => {
  assert.equal(
    toHex(addressToBytes32("0xab")),
    "00000000000000000000000000000000000000000000000000000000000000ab"
  );
  assert.equal(addressToBytes32("0x" + "ff".repeat(32)).length, 32);
  assert.throws(() => addressToBytes32("0x" + "ff".repeat(33)));
});

test("StateUpdateWriter is byte-identical to serializeStateUpdate", () => {
  const w = new StateUpdateWriter("0xab", 32);
  const fast = w.write(stateHash, 42n, 1234567890n, 1000n, 2000n);
  assert.equal(toHex(fast), G_STATE_UPDATE);
  // reuse produces correct, independent output
  const second = w.write(stateHash, 43n, 1234567890n, 1500n, 1500n);
  const slow = serializeStateUpdate({
    tunnelId: "0xab",
    stateHash,
    nonce: 43n,
    timestamp: 1234567890n,
    partyABalance: 1500n,
    partyBBalance: 1500n,
  });
  assert.equal(toHex(second), toHex(slow));
});
