import { test } from "node:test";
import assert from "node:assert/strict";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  generateKeyPair,
  keyPairFromSecret,
  ed25519Address,
  toB64,
  fromB64,
  generateWalletPoolId,
  generateAccessValue,
} from "./crypto";

test("ed25519Address matches @mysten derivation", () => {
  const kp = generateKeyPair();
  const mysten = Ed25519Keypair.fromSecretKey(kp.secretKey);
  assert.equal(
    ed25519Address(kp.publicKey),
    mysten.getPublicKey().toSuiAddress(),
  );
});

test("keyPairFromSecret round-trips", () => {
  const kp = generateKeyPair();
  assert.deepEqual(keyPairFromSecret(kp.secretKey).publicKey, kp.publicKey);
});

test("base64 round-trips", () => {
  const b = generateKeyPair().secretKey;
  assert.deepEqual(fromB64(toB64(b)), new Uint8Array(b));
});

test("id and access shapes", () => {
  assert.match(generateWalletPoolId(), /^wp_[A-Za-z0-9_-]{22}$/);
  assert.equal(generateAccessValue().length, 43);
});
