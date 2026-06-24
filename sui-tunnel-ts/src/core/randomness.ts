/**
 * Verifiable randomness, byte-exact with `randomness.move`.
 *
 * Mirrors the on-chain seed chaining, unbiased range sampling (rejection sampling),
 * and Fisher-Yates shuffle so that a deck/permutation derived off-chain can be
 * RE-DERIVED and adjudicated on-chain during a dispute. Combined with the two-party
 * commit-reveal in `commitment.ts`, this gives a dealerless shuffle neither party can
 * bias (the fairness core of Quantum Poker). Cross-checked against Move in
 * `sui_tunnel/tests/randomness_xcheck_tests.move`.
 */

import { concatBytes } from "./bytes";
import { blake2b256 } from "./crypto";
import { u64ToBeBytes } from "./wire";

const DOMAIN_CHAIN = new TextEncoder().encode("sui_tunnel::randomness::chain");
const U64_MAX = (1n << 64n) - 1n;

/** A randomness seed: 32 bytes + a derivation counter (matches Move `Seed`). */
export interface Seed {
  bytes: Uint8Array;
  counter: bigint;
}

/** Wrap raw 32 bytes as a fresh seed (counter 0), e.g. a commit-reveal joint seed. */
export function seedFromBytes(bytes: Uint8Array): Seed {
  return { bytes, counter: 0n };
}

/** `next_seed`: blake2b256(DOMAIN_CHAIN || seed.bytes || u64be(counter)), counter reset to 0. */
export function nextSeed(seed: Seed): Seed {
  return {
    bytes: blake2b256(
      concatBytes([DOMAIN_CHAIN, seed.bytes, u64ToBeBytes(seed.counter)]),
    ),
    counter: 0n,
  };
}

function bytesToU64BE(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[i]);
  return v;
}

/** `next_u64`: first 8 bytes (big-endian) of the chained seed. */
export function nextU64(seed: Seed): [bigint, Seed] {
  const ns = nextSeed(seed);
  return [
    bytesToU64BE(ns.bytes),
    { bytes: ns.bytes, counter: ns.counter + 1n },
  ];
}

/** Unbiased value in [min, max) via rejection sampling. Matches `next_u64_in_range`. */
export function nextU64InRange(
  seed: Seed,
  min: bigint,
  max: bigint,
): [bigint, Seed] {
  if (min >= max) throw new Error("invalid randomness range");
  const range = max - min;
  if (range === 1n) {
    const ns = nextSeed(seed);
    return [min, { bytes: ns.bytes, counter: ns.counter + 1n }];
  }
  const remainder = ((U64_MAX % range) + 1n) % range;
  const threshold = remainder === 0n ? 0n : U64_MAX - remainder + 1n;
  let current = seed;
  for (;;) {
    const ns = nextSeed(current);
    const raw = bytesToU64BE(ns.bytes);
    if (threshold === 0n || raw < threshold) {
      return [
        (raw % range) + min,
        { bytes: ns.bytes, counter: ns.counter + 1n },
      ];
    }
    current = ns; // rejected — advance and retry
  }
}

/** In-place Fisher-Yates shuffle. Returns the final seed. Matches `shuffle`. */
export function shuffle<T>(seed: Seed, arr: T[]): Seed {
  const n = arr.length;
  if (n <= 1) return seed;
  let current = seed;
  for (let i = n - 1; i > 0; i--) {
    const [jb, ns] = nextU64InRange(current, 0n, BigInt(i + 1));
    current = ns;
    const j = Number(jb);
    if (i !== j) {
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
  }
  return current;
}

/** Draw a random element, removing it via swap-remove. Matches `draw_from_vector`. */
export function drawFromVector<T>(seed: Seed, arr: T[]): [T, Seed] {
  if (arr.length === 0) throw new Error("empty vector");
  const [idxb, ns] = nextU64InRange(seed, 0n, BigInt(arr.length));
  const idx = Number(idxb);
  const el = arr[idx];
  arr[idx] = arr[arr.length - 1];
  arr.pop();
  return [el, ns];
}
