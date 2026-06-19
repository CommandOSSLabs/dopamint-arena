import { fromHEX } from "@mysten/bcs";
import { blake2b } from "@noble/hashes/blake2b";

// Deterministically pick one cell from `optimalCells` using a verifiable seed
// (the server's previous BLS signature, which the player already holds).
export function deriveServerMove(
  optimalCells: number[],
  seedHex: string,
): number {
  if (optimalCells.length === 0)
    throw new Error("deriveServerMove: empty optimalCells");
  const hash = blake2b(fromHEX(seedHex), { dkLen: 32 });
  const n =
    ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0;
  return optimalCells[n % optimalCells.length];
}
