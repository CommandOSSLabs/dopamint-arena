import assert from "node:assert/strict";
import { test } from "node:test";
import { PaymentMove, PaymentsProtocol } from "../protocol/payments";
import { toHex } from "./bytes";
import {
  ed25519Address,
  generateKeyPair,
  keyPairFromSecret,
  verify,
} from "./crypto";
import { OffchainTunnel, verifyCoSignedUpdate } from "./tunnel";
import { serializeSettlement } from "./wire";

const TUNNEL_ID = "0x" + "11".repeat(32);

function selfPlayPayments(a = 1_000_000n, b = 1_000_000n) {
  const kpA = generateKeyPair();
  const kpB = generateKeyPair();
  return OffchainTunnel.selfPlay(
    new PaymentsProtocol(),
    TUNNEL_ID,
    kpA,
    kpB,
    ed25519Address(kpA.publicKey),
    ed25519Address(kpB.publicKey),
    { a, b }
  );
}

test("step applies move, increments nonce, conserves total, verifies in full mode", () => {
  const t = selfPlayPayments();
  const total = t.total;
  const r1 = t.step({ from: "A", amount: 100n }, "A");
  assert.equal(r1.nonce, 1n);
  assert.ok(r1.verified);
  assert.ok(r1.signed);
  assert.equal(t.state.balanceA, 999_900n);
  assert.equal(t.state.balanceB, 1_000_100n);

  const r2 = t.step({ from: "B", amount: 50n }, "B");
  assert.equal(r2.nonce, 2n);
  assert.equal(t.state.balanceA + t.state.balanceB, total);
});

test("latest co-signed update verifies independently (settleable on-chain)", () => {
  const t = selfPlayPayments();
  t.step({ from: "A", amount: 12345n }, "A");
  const u = t.latest!;
  assert.equal(u.update.nonce, 1n);
  assert.ok(
    verifyCoSignedUpdate(
      u,
      { publicKey: t.partyA.publicKey, scheme: t.partyA.scheme },
      { publicKey: t.partyB.publicKey, scheme: t.partyB.scheme }
    )
  );
});

test("deterministic replay: same keys + same moves => identical signed bytes", () => {
  const kpA = keyPairFromSecret(
    Uint8Array.from({ length: 32 }, (_, i) => i + 1)
  );
  const kpB = keyPairFromSecret(
    Uint8Array.from({ length: 32 }, (_, i) => i + 33)
  );
  const moves: PaymentMove[] = [
    { from: "A", amount: 10n },
    { from: "B", amount: 7n },
    { from: "A", amount: 3n },
  ];
  const build = () => {
    const t = OffchainTunnel.selfPlay(
      new PaymentsProtocol(),
      TUNNEL_ID,
      kpA,
      kpB,
      ed25519Address(kpA.publicKey),
      ed25519Address(kpB.publicKey),
      { a: 100n, b: 100n }
    );
    for (const m of moves) t.step(m, m.from, { timestamp: 1000n });
    return t.latest!;
  };
  const u1 = build();
  const u2 = build();
  assert.equal(toHex(u1.sigA), toHex(u2.sigA));
  assert.equal(toHex(u1.sigB), toHex(u2.sigB));
  assert.equal(toHex(u1.update.stateHash), toHex(u2.update.stateHash));
});

test("illegal move (overspend) throws and leaves state unchanged", () => {
  const t = selfPlayPayments(100n, 100n);
  assert.throws(() => t.step({ from: "A", amount: 101n }, "A"));
  assert.equal(t.nonce, 0n);
  assert.equal(t.state.balanceA, 100n);
});

test("buildSettlement produces signatures that verify over the settlement message", () => {
  const t = selfPlayPayments();
  t.step({ from: "A", amount: 500n }, "A");
  const s = t.buildSettlement(1234567890n);
  assert.equal(s.settlement.finalNonce, 1n); // on-chain state.nonce(0) + 1, matching close_cooperative
  const msg = serializeSettlement(s.settlement);
  assert.ok(verify(s.sigA, msg, t.partyA.publicKey));
  assert.ok(verify(s.sigB, msg, t.partyB.publicKey));
});

test("REPRO #3: settlement verifies over the message close_cooperative rebuilds (final_nonce = on-chain nonce + 1)", () => {
  const t = selfPlayPayments();
  t.step({ from: "A", amount: 500n }, "A");
  t.step({ from: "B", amount: 200n }, "B"); // off-chain nonce is now 2
  const s = t.buildSettlement(1234567890n);
  // tunnel::close_cooperative IGNORES any supplied nonce and rebuilds the signed
  // message with final_nonce = tunnel.state.nonce + 1. For a tunnel that never
  // submitted update_state on-chain, tunnel.state.nonce is 0, so the chain rebuilds
  // final_nonce = 1. The co-signatures MUST verify over THAT message.
  const onchainStateNonce = 0n;
  const chainMsg = serializeSettlement({
    tunnelId: s.settlement.tunnelId,
    partyABalance: s.settlement.partyABalance,
    partyBBalance: s.settlement.partyBBalance,
    finalNonce: onchainStateNonce + 1n,
    timestamp: s.settlement.timestamp,
  });
  assert.ok(
    verify(s.sigA, chainMsg, t.partyA.publicKey),
    "sigA must verify over the chain-rebuilt settlement message"
  );
  assert.ok(
    verify(s.sigB, chainMsg, t.partyB.publicKey),
    "sigB must verify over the chain-rebuilt settlement message"
  );
});

test("sign-only and none modes", () => {
  const t = selfPlayPayments();
  const so = t.step({ from: "A", amount: 1n }, "A", { mode: "sign-only" });
  assert.ok(so.signed);
  assert.ok(!so.verified);
  assert.ok(so.messageBytes > 0);
  const none = t.step({ from: "A", amount: 1n }, "A", { mode: "none" });
  assert.equal(none.signed, null);
  assert.ok(none.messageBytes > 0);
  assert.equal(t.nonce, 2n);
});

test("onUpdate observer fires per co-signed update with byte count", () => {
  const t = selfPlayPayments();
  let count = 0;
  let bytes = 0;
  t.onUpdate = (_u, n) => {
    count++;
    bytes += n;
  };
  t.step({ from: "A", amount: 1n }, "A");
  t.step({ from: "B", amount: 1n }, "B");
  assert.equal(count, 2);
  assert.equal(bytes, 120 * 2); // 120-byte state_update each
});
