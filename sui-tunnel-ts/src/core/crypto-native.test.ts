import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "./bytes";
import {
  defaultBackend,
  keyPairFromSecret,
  nativeBackend,
  nativeBackendSupported,
  nobleBackend,
  verify as nobleVerify,
} from "./index";

const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const kp = keyPairFromSecret(seed);
const msg = Uint8Array.from({ length: 120 }, (_, i) => (i * 7) & 0xff);

test("native ed25519 is supported in node and is the default backend", () => {
  assert.ok(nativeBackendSupported());
  assert.equal(defaultBackend().name, "native");
});

test("native signatures are byte-identical to noble (deterministic ed25519)", () => {
  const nativeSig = nativeBackend.makeSigner(seed)(msg);
  const nobleSig = nobleBackend.makeSigner(seed)(msg);
  assert.equal(toHex(nativeSig), toHex(nobleSig));
  assert.equal(nativeSig.length, 64);
});

test("native and noble verifiers each accept the other's signatures", () => {
  const nativeSig = nativeBackend.makeSigner(seed)(msg);
  const nobleSig = nobleBackend.makeSigner(seed)(msg);
  assert.ok(nativeBackend.makeVerifier(kp.publicKey)(msg, nobleSig));
  assert.ok(nobleBackend.makeVerifier(kp.publicKey)(msg, nativeSig));
  // and the standalone noble verify (used by audits / on-chain-equivalent path)
  assert.ok(nobleVerify(nativeSig, msg, kp.publicKey));
});

test("verifier rejects tampered input", () => {
  const sig = nativeBackend.makeSigner(seed)(msg);
  const bad = Uint8Array.from(msg);
  bad[0] ^= 0xff;
  assert.ok(!nativeBackend.makeVerifier(kp.publicKey)(bad, sig));
});

test("native-backed tunnel produces updates that verify via noble (on-chain path)", async () => {
  const {
    OffchainTunnel,
    verifyCoSignedUpdate,
    generateKeyPair,
    ed25519Address,
  } = await import("./index");
  const { PaymentsProtocol } = await import("../protocol/payments");
  const a = generateKeyPair();
  const b = generateKeyPair();
  const t = OffchainTunnel.selfPlay(
    new PaymentsProtocol(),
    "0x" + "22".repeat(32),
    a,
    b,
    ed25519Address(a.publicKey),
    ed25519Address(b.publicKey),
    { a: 1000n, b: 1000n },
    nativeBackend
  );
  t.step({ from: "A", amount: 10n }, "A");
  const u = t.latest!;
  assert.ok(
    verifyCoSignedUpdate(
      u,
      { publicKey: t.partyA.publicKey, scheme: t.partyA.scheme },
      { publicKey: t.partyB.publicKey, scheme: t.partyB.scheme }
    )
  );
});
