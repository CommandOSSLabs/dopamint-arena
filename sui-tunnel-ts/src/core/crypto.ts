/**
 * Off-chain crypto for the tunnel hot path.
 *
 * Uses @noble/curves ed25519 directly for SYNCHRONOUS sign/verify — the @mysten
 * `Ed25519Keypair.sign()` is async and adds per-call Promise overhead that caps
 * throughput. Signatures produced here are byte-compatible with @mysten keypairs
 * and verify on-chain via `signature::ed25519` (raw message, NO intent wrapper,
 * NO pre-hash) — verified by interop tests in crypto.test.ts.
 *
 * ed25519 is the default tunnel scheme: cheapest on-chain verify gas and fastest
 * off-chain signing. BLS (for aggregation / settlement compression, Deliverable 8)
 * and secp256k1 are added in later phases behind {@link verifyWithScheme}.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2b";
import { toHex } from "./bytes";

/** Signature scheme ids, matching `signature.move` (ed25519=0 .. secp256k1=3). */
export const SignatureScheme = {
  ED25519: 0,
  BLS12381_MIN_SIG: 1,
  BLS12381_MIN_PK: 2,
  SECP256K1: 3,
} as const;
export type SignatureSchemeId =
  (typeof SignatureScheme)[keyof typeof SignatureScheme];

/** Blake2b-256 (32-byte output), matching Sui's `hash::blake2b256`. */
export function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 });
}

export interface KeyPair {
  /** 32-byte ed25519 secret seed. */
  secretKey: Uint8Array;
  /** 32-byte ed25519 public key (the value stored in PartyConfig.public_key). */
  publicKey: Uint8Array;
  scheme: SignatureSchemeId;
}

function randomEd25519Secret(): Uint8Array {
  // @noble/curves v2 renamed randomPrivateKey -> randomSecretKey; support both.
  const u = ed25519.utils as unknown as {
    randomSecretKey?: () => Uint8Array;
    randomPrivateKey?: () => Uint8Array;
  };
  if (u.randomSecretKey) return u.randomSecretKey();
  if (u.randomPrivateKey) return u.randomPrivateKey();
  throw new Error("@noble/curves ed25519: no random secret key generator");
}

/** Generate a fresh ephemeral ed25519 keypair. */
export function generateKeyPair(): KeyPair {
  const secretKey = randomEd25519Secret();
  return {
    secretKey,
    publicKey: ed25519.getPublicKey(secretKey),
    scheme: SignatureScheme.ED25519,
  };
}

/** Generate `n` ephemeral keypairs (for N-user / N-agent simulations). */
export function generateKeyPairs(n: number): KeyPair[] {
  const out = new Array<KeyPair>(n);
  for (let i = 0; i < n; i++) out[i] = generateKeyPair();
  return out;
}

/**
 * Deterministic keypair from a seeded RNG (returns floats in [0,1)). For
 * SIMULATIONS only — gives reproducible identities so a (seed, config) pair fully
 * determines a run (deterministic replay). Do NOT use for real funds: the entropy
 * is only as good as the RNG. Production identities use {@link generateKeyPair}.
 */
export function keyPairFromRng(rng: () => number): KeyPair {
  const secretKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) secretKey[i] = (rng() * 256) | 0;
  return keyPairFromSecret(secretKey);
}

/** Reconstruct a keypair from a 32-byte ed25519 secret seed. */
export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  if (secretKey.length !== 32) {
    throw new Error(`ed25519 secret must be 32 bytes, got ${secretKey.length}`);
  }
  return {
    secretKey,
    publicKey: ed25519.getPublicKey(secretKey),
    scheme: SignatureScheme.ED25519,
  };
}

/** Sign a RAW message with ed25519 (synchronous). Returns a 64-byte signature. */
export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

/** Verify a RAW-message ed25519 signature (synchronous). */
export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    // noble throws on malformed inputs; treat as a failed verification.
    return false;
  }
}

/**
 * Scheme-aware verification mirroring `signature::verify`. ed25519 is implemented;
 * BLS / secp256k1 are wired in later phases (BLS for aggregation in Deliverable 8).
 */
export function verifyWithScheme(
  scheme: SignatureSchemeId,
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  switch (scheme) {
    case SignatureScheme.ED25519:
      return verify(signature, message, publicKey);
    default:
      throw new Error(
        `signature scheme ${scheme} not yet supported off-chain (added in a later phase)`,
      );
  }
}

/**
 * Derive a Sui address from an ed25519 public key:
 * `0x || blake2b256(0x00 flag || public_key)`. Matches
 * `Ed25519PublicKey.toSuiAddress()` and Sui's address derivation.
 */
export function ed25519Address(publicKey: Uint8Array): string {
  const data = new Uint8Array(1 + publicKey.length);
  data[0] = 0x00; // ed25519 scheme flag
  data.set(publicKey, 1);
  return "0x" + toHex(blake2b256(data));
}

// ============================================
// PLUGGABLE BACKENDS (hot-path performance)
// ============================================

/** A bound signer: produces a 64-byte ed25519 signature over `message`. */
export type SignFn = (message: Uint8Array) => Uint8Array;
/** A bound verifier: checks a signature over `message` against a fixed key. */
export type VerifyFn = (message: Uint8Array, signature: Uint8Array) => boolean;

/**
 * A crypto backend produces signers/verifiers bound to raw ed25519 keys.
 * Because ed25519 (RFC 8032) is deterministic, every correct backend yields
 * BYTE-IDENTICAL signatures for the same (key, message) — so signatures from any
 * backend verify on-chain and against any other backend. The native backend
 * (node:crypto / OpenSSL) is ~15× faster at verification than pure-JS @noble and is
 * the default in Node; @noble is the portable/browser fallback.
 */
export interface CryptoBackend {
  readonly name: string;
  /** Bind a signer to a 32-byte secret seed (may precompute key material). */
  makeSigner(secretKey: Uint8Array): SignFn;
  /** Bind a verifier to a 32-byte public key (may precompute key material). */
  makeVerifier(publicKey: Uint8Array): VerifyFn;
}

/** Pure-JS backend (portable, browser-safe, the one cross-checked against Move). */
export const nobleBackend: CryptoBackend = {
  name: "noble",
  makeSigner: (secretKey) => (message) => ed25519.sign(message, secretKey),
  makeVerifier: (publicKey) => (message, signature) =>
    verify(signature, message, publicKey),
};
