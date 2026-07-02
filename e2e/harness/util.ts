// Deterministic RNG so self-play games are reproducible across runs.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fixed 32-byte transcript root. The chain treats the root as opaque (only
 *  length is checked); both seats must sign the SAME bytes, which the settlement
 *  builder guarantees. */
export function root32(fill = 0x7a): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
