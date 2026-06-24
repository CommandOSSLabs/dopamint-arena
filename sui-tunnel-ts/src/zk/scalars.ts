/**
 * Public-input scalar encoding, byte-exact with `zk_verifier.move`.
 *
 * Groth16 public inputs on Sui are a concatenation of 32-byte scalars
 * (`groth16::public_proof_inputs_from_bytes`). The SDK must build that blob with the
 * SAME layout the on-chain verifier expects: u64 scalars are LITTLE-ENDIAN, padded to
 * 32 bytes (zk_verifier.move:543); hash scalars are the raw 32-byte digest; addresses
 * are big-endian 32 bytes. Cross-checked in `sui_tunnel/tests/zk_inputs_xcheck_tests.move`.
 */

import { concatBytes } from "../core/bytes";

const SCALAR_SIZE = 32;

/** u64 -> 32-byte LITTLE-ENDIAN scalar (matches `zk_verifier::u64_to_scalar`). */
export function u64ToScalar(value: bigint | number): Uint8Array {
  let v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n || v > (1n << 64n) - 1n)
    throw new RangeError(`u64 out of range: ${v}`);
  const out = new Uint8Array(SCALAR_SIZE);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** u256 -> 32-byte little-endian scalar (matches `zk_verifier::u256_to_scalar`). */
export function u256ToScalar(value: bigint): Uint8Array {
  let v = value;
  if (v < 0n) throw new RangeError("u256 must be non-negative");
  const out = new Uint8Array(SCALAR_SIZE);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * A 32-byte digest used directly as a scalar. The card circuit feeds the deck
 * root verbatim into `concat_scalars` on-chain (it is NOT passed through
 * `zk_verifier::hash_to_scalar`), so this is the identity, not a blake2b256 hash.
 */
export function hashScalar(hash32: Uint8Array): Uint8Array {
  if (hash32.length !== SCALAR_SIZE) {
    throw new Error(`hash scalar must be 32 bytes, got ${hash32.length}`);
  }
  return hash32;
}

/** Concatenate 32-byte scalars into a public-inputs blob (matches `concat_scalars`). */
export function concatScalars(scalars: Uint8Array[]): Uint8Array {
  if (scalars.length > 8)
    throw new Error("at most 8 public inputs (Sui limit)");
  for (const s of scalars) {
    if (s.length !== SCALAR_SIZE)
      throw new Error("each scalar must be 32 bytes");
  }
  return concatBytes(scalars);
}
