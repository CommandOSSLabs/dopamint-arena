/**
 * Fleet-secret factories for Battleship vs-bot. Provides the commitment
 * primitives (`FleetSecret`, `makeFleetSecret`, `randomFleetSecret`,
 * `secureSalt`) used by the session hook and kit wiring. The move driver
 * moved to the agent kit + battleshipSelfPlay.ts.
 */
import { computeCommitment } from "sui-tunnel-ts/core/commitment";
import { placeFleetRandom, placementsToBoard } from "./fleet";

/** A player's secret board + single salt + the board-hash commitment. */
export interface FleetSecret {
  board: Uint8Array;
  salt: Uint8Array;
  commitment: Uint8Array;
}

/** 16 cryptographically-secure random bytes (browser/Node CSPRNG). */
export function secureSalt(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(16));
}

export function makeFleetSecret(
  board: Uint8Array,
  salt: Uint8Array,
): FleetSecret {
  return { board, salt, commitment: computeCommitment(board, salt) };
}

export function randomFleetSecret(rng: () => number): FleetSecret {
  const board = placementsToBoard(placeFleetRandom(rng));
  const salt = new Uint8Array(16);
  for (let i = 0; i < salt.length; i++) salt[i] = Math.floor(rng() * 256);
  return makeFleetSecret(board, salt);
}
