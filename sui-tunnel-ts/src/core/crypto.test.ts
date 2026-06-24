import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "./bytes";
import {
  blake2b256,
  ed25519Address,
  generateKeyPair,
  generateKeyPairs,
  keyPairFromSecret,
  sign,
  SignatureScheme,
  verify,
  verifyWithScheme,
} from "./crypto";

const msg = new TextEncoder().encode("sui_tunnel::state_update example");

test("ed25519 sign/verify roundtrip", () => {
  const kp = generateKeyPair();
  assert.equal(kp.publicKey.length, 32);
  assert.equal(kp.secretKey.length, 32);
  const sig = sign(msg, kp.secretKey);
  assert.equal(sig.length, 64);
  assert.ok(verify(sig, msg, kp.publicKey));
});

test("verify rejects tampered message and bad signature", () => {
  const kp = generateKeyPair();
  const sig = sign(msg, kp.secretKey);
  const tampered = Uint8Array.from(msg);
  tampered[0] ^= 0xff;
  assert.ok(!verify(sig, tampered, kp.publicKey));
  const badSig = Uint8Array.from(sig);
  badSig[0] ^= 0xff;
  assert.ok(!verify(badSig, msg, kp.publicKey));
  assert.ok(!verify(new Uint8Array(10), msg, kp.publicKey)); // malformed length
});

test("verifyWithScheme dispatches ed25519 and rejects unimplemented schemes", () => {
  const kp = generateKeyPair();
  const sig = sign(msg, kp.secretKey);
  assert.ok(verifyWithScheme(SignatureScheme.ED25519, kp.publicKey, msg, sig));
  assert.throws(() =>
    verifyWithScheme(SignatureScheme.BLS12381_MIN_SIG, kp.publicKey, msg, sig)
  );
});

test("keyPairFromSecret reproduces the same public key", () => {
  const kp = generateKeyPair();
  const kp2 = keyPairFromSecret(kp.secretKey);
  assert.equal(toHex(kp2.publicKey), toHex(kp.publicKey));
});

test("noble signatures interoperate with @mysten Ed25519Keypair (on-chain compatible)", async () => {
  const mysten = new Ed25519Keypair();
  const { secretKey } = decodeSuiPrivateKey(mysten.getSecretKey());
  const ours = keyPairFromSecret(secretKey);
  assert.equal(
    toHex(ours.publicKey),
    toHex(mysten.getPublicKey().toRawBytes())
  );

  // our (noble) signature verifies under @mysten's public key (raw verify)
  const sig = sign(msg, ours.secretKey);
  assert.ok(await mysten.getPublicKey().verify(msg, sig));
  // and @mysten's signature verifies under our verifier
  const mSig = await mysten.sign(msg);
  assert.ok(verify(mSig, msg, ours.publicKey));
});

test("ed25519Address matches @mysten toSuiAddress", () => {
  const mysten = new Ed25519Keypair();
  const pk = mysten.getPublicKey().toRawBytes();
  assert.equal(ed25519Address(pk), mysten.getPublicKey().toSuiAddress());
});

test("blake2b256(hello) matches Move hash::blake2b256", () => {
  assert.equal(
    toHex(blake2b256(new TextEncoder().encode("hello"))),
    "324dcf027dd4a30a932c441f365a25e86b173defa4b8e58948253471b81b72cf"
  );
});

test("generateKeyPairs returns n distinct keys", () => {
  const kps = generateKeyPairs(50);
  const seen = new Set(kps.map((k) => toHex(k.publicKey)));
  assert.equal(seen.size, 50);
});
