/**
 * Deterministic seedable PRNG (mulberry32) for reproducible simulations and replay.
 *
 * The framework requires deterministic replay; using a seeded RNG (instead of
 * Math.random) means a (seed, config) pair fully determines the generated workload,
 * so runs are reproducible across machines and the proof-of-existence transcript can
 * be regenerated and re-verified.
 */

export type Rng = () => number;

/** Create a deterministic float-in-[0,1) generator from a 32-bit seed. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive an independent sub-stream seed (e.g. per worker / per tunnel shard). */
export function deriveSeed(seed: number, index: number): number {
  // splitmix-style mix so nearby (seed,index) produce well-separated streams.
  let z = (seed + index * 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}
