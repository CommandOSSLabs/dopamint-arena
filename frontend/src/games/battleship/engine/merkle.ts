/**
 * Board commitment: a Merkle tree over a player's 100 cells.
 *
 * Each player commits a 32-byte root at placement; when shot at, they reveal a
 * single cell with its salt and a Merkle proof, so the opponent learns whether
 * *that* cell is a ship without learning any other cell. The protocol verifies
 * the proof against the committed root inside `applyMove`, so a peer cannot
 * advance the co-signed state with a lie about a hit. See ADR 0003.
 *
 * Leaves and internal nodes are domain-separated (0x00 / 0x01 prefixes) so a
 * leaf hash can never be reinterpreted as an internal node (second-preimage).
 * The 100 cells are padded to 128 leaves with a constant; cells 100..127 are
 * never proven, so the padding value only needs to be agreed (it is, here).
 */

import { blake2b256 } from "sui-tunnel-ts/core/crypto";
import { concatBytes } from "sui-tunnel-ts/core/bytes";
import { CELL_COUNT } from "./fleet";

export const SALT_BYTES = 32;
/** Smallest power of two ≥ CELL_COUNT (100), so the tree is perfect. */
const TREE_LEAVES = 128;

const LEAF_TAG = Uint8Array.of(0x00);
const NODE_TAG = Uint8Array.of(0x01);
const PAD_LEAF = blake2b256(Uint8Array.of(0x02));

function leafHash(cell: number, isShip: boolean, salt: Uint8Array): Uint8Array {
  if (salt.length !== SALT_BYTES)
    throw new Error(`salt must be ${SALT_BYTES} bytes`);
  return blake2b256(
    concatBytes([LEAF_TAG, Uint8Array.of(cell, isShip ? 1 : 0), salt]),
  );
}

function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return blake2b256(concatBytes([NODE_TAG, left, right]));
}

export interface BoardCommitment {
  /** 32-byte Merkle root — the public commitment shared with the opponent. */
  root: Uint8Array;
  /** All tree layers, layer 0 = the 128 leaves, last layer = [root]. Kept to build proofs. */
  layers: Uint8Array[][];
}

/**
 * Commit a board: `board[cell]` is 1 for a ship, 0 for water; `salts[cell]` is a
 * fresh {@link SALT_BYTES}-byte salt. Returns the root plus the layers needed to
 * prove individual cells later.
 */
export function commitBoard(
  board: Uint8Array,
  salts: Uint8Array[],
): BoardCommitment {
  if (board.length !== CELL_COUNT)
    throw new Error(`board must be ${CELL_COUNT} cells`);
  if (salts.length !== CELL_COUNT) throw new Error(`need ${CELL_COUNT} salts`);

  const leaves: Uint8Array[] = new Array(TREE_LEAVES);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    leaves[cell] = leafHash(cell, board[cell] === 1, salts[cell]);
  }
  for (let i = CELL_COUNT; i < TREE_LEAVES; i++) leaves[i] = PAD_LEAF;

  const layers: Uint8Array[][] = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next: Uint8Array[] = new Array(cur.length / 2);
    for (let i = 0; i < cur.length; i += 2) {
      next[i / 2] = nodeHash(cur[i], cur[i + 1]);
    }
    layers.push(next);
    cur = next;
  }
  return { root: cur[0], layers };
}

/** The sibling hashes from a cell's leaf up to the root (length log2(128) = 7). */
export function proveCell(
  commitment: BoardCommitment,
  cell: number,
): Uint8Array[] {
  if (cell < 0 || cell >= CELL_COUNT)
    throw new Error(`cell out of range: ${cell}`);
  const proof: Uint8Array[] = [];
  let idx = cell;
  for (let level = 0; level < commitment.layers.length - 1; level++) {
    const sibling = idx ^ 1;
    proof.push(commitment.layers[level][sibling]);
    idx >>= 1;
  }
  return proof;
}

/**
 * Verify that `cell` has value `isShip` under the committed `root`, given the
 * revealed `salt` and Merkle `proof`. This is what the protocol runs on every
 * reveal; it returns false (never throws) on any inconsistency.
 */
export function verifyCell(
  root: Uint8Array,
  cell: number,
  isShip: boolean,
  salt: Uint8Array,
  proof: Uint8Array[],
): boolean {
  if (cell < 0 || cell >= CELL_COUNT) return false;
  if (salt.length !== SALT_BYTES) return false;
  let h = leafHash(cell, isShip, salt);
  let idx = cell;
  for (const sibling of proof) {
    h = idx % 2 === 0 ? nodeHash(h, sibling) : nodeHash(sibling, h);
    idx >>= 1;
  }
  return h.length === root.length && h.every((b, i) => b === root[i]);
}

/** Fresh cryptographically-random salts, one per cell. Used by the live game (not tests). */
export function randomSalts(): Uint8Array[] {
  const salts: Uint8Array[] = new Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i++) {
    const s = new Uint8Array(SALT_BYTES);
    globalThis.crypto.getRandomValues(s);
    salts[i] = s;
  }
  return salts;
}
