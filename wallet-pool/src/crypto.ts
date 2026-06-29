import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2b";
import { randomBytes as nodeRandomBytes } from "node:crypto";

export interface KeyPair {
  /** 32-byte ed25519 secret seed. */
  secretKey: Uint8Array;
  /** 32-byte ed25519 public key. */
  publicKey: Uint8Array;
}

export function randomBytes(n: number): Uint8Array {
  return nodeRandomBytes(n);
}

export function generateKeyPair(): KeyPair {
  const secretKey = randomBytes(32);
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

export function generateKeyPairs(n: number): KeyPair[] {
  return Array.from({ length: n }, generateKeyPair);
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  if (secretKey.length !== 32) {
    throw new Error(`ed25519 secret must be 32 bytes, got ${secretKey.length}`);
  }
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

/** `0x || blake2b256(0x00 flag || publicKey)` — matches Sui ed25519 address derivation. */
export function ed25519Address(publicKey: Uint8Array): string {
  const data = new Uint8Array(1 + publicKey.length);
  data[0] = 0x00;
  data.set(publicKey, 1);
  return "0x" + Buffer.from(blake2b(data, { dkLen: 32 })).toString("hex");
}

export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromB64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export function generateWalletPoolId(): string {
  return "wp_" + Buffer.from(randomBytes(16)).toString("base64url");
}

export function generateAccessValue(): string {
  return Buffer.from(randomBytes(32)).toString("base64url");
}
