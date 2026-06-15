/**
 * Native ed25519 backend using node:crypto (OpenSSL). ~9× faster signing and
 * ~15× faster verification than pure-JS @noble, which is the binding constraint for
 * effective TPS (verification dominates the honest hot path). Signatures are standard
 * RFC 8032 ed25519 — byte-identical to @noble and accepted on-chain.
 *
 * Key material is precomputed once per signer/verifier (KeyObject construction is the
 * expensive part); the per-call cost is just OpenSSL sign/verify on the raw message.
 * Falls back to @noble automatically in non-Node environments (e.g. the browser).
 */

import * as nc from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { CryptoBackend, SignFn, VerifyFn, nobleBackend } from "./crypto";

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function privateKeyObject(secretKey: Uint8Array): nc.KeyObject {
  // node JWK import needs both d (seed) and x (public); derive x from the seed.
  const x = b64url(ed25519.getPublicKey(secretKey));
  return nc.createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: b64url(secretKey), x },
    format: "jwk",
  });
}

function publicKeyObject(publicKey: Uint8Array): nc.KeyObject {
  return nc.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: b64url(publicKey) },
    format: "jwk",
  });
}

export const nativeBackend: CryptoBackend = {
  name: "native",
  makeSigner: (secretKey): SignFn => {
    const key = privateKeyObject(secretKey);
    // crypto.sign accepts a Uint8Array view directly (no Buffer copy needed).
    return (message) => nc.sign(null, message, key);
  },
  makeVerifier: (publicKey): VerifyFn => {
    const key = publicKeyObject(publicKey);
    return (message, signature) => nc.verify(null, message, key, signature);
  },
};

let cachedSupported: boolean | undefined;

/** Whether node:crypto ed25519 is usable in this environment. */
export function nativeBackendSupported(): boolean {
  if (cachedSupported !== undefined) return cachedSupported;
  try {
    const seed = new Uint8Array(32);
    const sign = nativeBackend.makeSigner(seed);
    const verifyFn = nativeBackend.makeVerifier(ed25519.getPublicKey(seed));
    const msg = new Uint8Array([1, 2, 3]);
    cachedSupported = verifyFn(msg, sign(msg));
  } catch {
    cachedSupported = false;
  }
  return cachedSupported;
}

/** The fastest backend available here: native in Node, @noble elsewhere. */
export function defaultBackend(): CryptoBackend {
  return nativeBackendSupported() ? nativeBackend : nobleBackend;
}
