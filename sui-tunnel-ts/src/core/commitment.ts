/**
 * Two-party commit-reveal, byte-identical to `randomness.move`.
 *
 * This REPLACES the historically-buggy `utils.computeCommitment`, which hashed
 * `DOMAIN || value || salt` with NO length prefixes and therefore produced
 * commitments that fail `randomness::verify_commitment` on-chain. The Move code
 * length-prefixes every field (randomness.move:374-378, :395-399, :413-421):
 *
 *   commitment = blake2b256(DOMAIN || u64be(len(value)) || value || u64be(len(salt)) || salt)
 *   seed       = blake2b256(DOMAIN || lp(value_a) || lp(salt_a) || lp(value_b) || lp(salt_b))
 *
 * where `lp(x) = u64be(len(x)) || x`. These are the dealerless-fairness primitives
 * behind coin-flip / RPS / Quantum Poker. Cross-checked against Move in
 * `sui_tunnel/tests/wire_format_tests.move`.
 */

import { bytesEqual, concatBytes } from "./bytes";
import { blake2b256 } from "./crypto";
import { u64ToBeBytes } from "./wire";

const enc = new TextEncoder();

/** `b"sui_tunnel::randomness::commit_reveal"`. Matches `DOMAIN_COMMIT_REVEAL`. */
export const DOMAIN_COMMIT_REVEAL = enc.encode(
  "sui_tunnel::randomness::commit_reveal",
);

/** Minimum salt length enforced by `randomness::create_commitment` (>= 16 bytes). */
export const MIN_SALT_LEN = 16;

function lengthPrefixed(x: Uint8Array): Uint8Array[] {
  return [u64ToBeBytes(x.length), x];
}

/**
 * Compute a commit-reveal commitment hash. Mirrors `randomness::create_commitment`
 * (only the hash; committer/timestamp are stored alongside but are NOT hashed).
 */
function hashCommitment(value: Uint8Array, salt: Uint8Array): Uint8Array {
  return blake2b256(
    concatBytes([
      DOMAIN_COMMIT_REVEAL,
      ...lengthPrefixed(value),
      ...lengthPrefixed(salt),
    ]),
  );
}

export function computeCommitment(
  value: Uint8Array,
  salt: Uint8Array,
): Uint8Array {
  if (salt.length < MIN_SALT_LEN) {
    throw new Error(
      `salt must be >= ${MIN_SALT_LEN} bytes, got ${salt.length}`,
    );
  }
  return hashCommitment(value, salt);
}

/**
 * Verify a reveal `(value, salt)` against a commitment hash. Returns `false` for
 * any non-matching reveal, including a salt shorter than 16 bytes, mirroring Move
 * `randomness::verify_commitment`, which never aborts. Only `create_commitment`
 * (the commit path, here `computeCommitment`) enforces the `>= 16`-byte salt.
 */
export function verifyCommitment(
  commitmentHash: Uint8Array,
  value: Uint8Array,
  salt: Uint8Array,
): boolean {
  return bytesEqual(hashCommitment(value, salt), commitmentHash);
}

/**
 * Combine two reveals into a 32-byte joint seed neither party can bias.
 * Mirrors `randomness::combine_reveals`. Both reveals should be verified against
 * their commitments first.
 */
export function combineReveals(
  valueA: Uint8Array,
  saltA: Uint8Array,
  valueB: Uint8Array,
  saltB: Uint8Array,
): Uint8Array {
  return blake2b256(
    concatBytes([
      DOMAIN_COMMIT_REVEAL,
      ...lengthPrefixed(valueA),
      ...lengthPrefixed(saltA),
      ...lengthPrefixed(valueB),
      ...lengthPrefixed(saltB),
    ]),
  );
}
