/**
 * Quantum Poker fairness via a Groth16 "card-in-committed-deck" circuit (Deliverable 3,
 * dispute-time only — never on the per-action hot path).
 *
 * Statement proven (PUBLIC): for a deck committed by Merkle root `deckRoot`, the card
 * `card` revealed at `position` is the genuine deck entry there — i.e. no card was
 * substituted between the dealerless shuffle and the showdown. WITNESS (private): the
 * card's salt and its Merkle inclusion path. This lets a player prove their showdown
 * cards came from the agreed shuffle without revealing the rest of the deck.
 *
 * SCOPE / HONEST NOTE: producing real Groth16 proofs requires a compiled circuit and a
 * trusted setup (circom + snarkjs), which is a DEPLOYMENT step, not a runtime one. This
 * module ships: (1) the exact public-input encoding the on-chain verifier
 * (`zk_verifier::verify_circuit_proof`) consumes, cross-checked against Move; (2) the
 * Merkle deck-commitment the SDK and circuit share; (3) a pluggable {@link CardProver}
 * so a real snarkjs prover/verifier can be dropped in; (4) the circuit source spec
 * ({@link CARD_IN_DECK_CIRCOM}). The dispute flow: prover builds proof off-chain → an
 * external referee verifies it via `zk_verifier` → resolves the dispute. The playable,
 * at-scale hidden-card mechanism (commit-reveal, see protocol/quantumPoker.ts) does NOT
 * require this; ZK is the optional strongest guarantee.
 */

import { blake2b256 } from "../core/crypto";
import { concatBytes, bytesEqual } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";
import { u64ToScalar, hashScalar, concatScalars } from "./scalars";

/** The public statement: card at `position` is in the deck committed by `deckRoot`. */
export interface CardStatement {
  /** 32-byte Merkle root committing to the shuffled deck. */
  deckRoot: Uint8Array;
  /** Deck slot index being opened (0..51). */
  position: number;
  /** Card value at that slot (0..51). */
  card: number;
}

/** Encode the public inputs blob the on-chain verifier consumes (96 bytes = 3 scalars). */
export function buildPublicInputs(stmt: CardStatement): Uint8Array {
  return concatScalars([
    hashScalar(stmt.deckRoot),
    u64ToScalar(stmt.position),
    u64ToScalar(stmt.card),
  ]);
}

// ---- Deck commitment (Merkle over per-card leaves) -----------------------------

const LEAF_DOMAIN = new TextEncoder().encode("sui_tunnel::poker::leaf");
const NODE_DOMAIN = new TextEncoder().encode("sui_tunnel::poker::node");

/** Leaf commitment for a card at a position with a per-card salt. */
export function cardLeaf(
  position: number,
  card: number,
  salt: Uint8Array,
): Uint8Array {
  return blake2b256(
    concatBytes([
      LEAF_DOMAIN,
      u64ToBeBytes(position),
      u64ToBeBytes(card),
      salt,
    ]),
  );
}

function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return blake2b256(concatBytes([NODE_DOMAIN, left, right]));
}

/**
 * Merkle root over 52 card leaves (padded to the next power of two with zero leaves).
 * Deterministic; both parties and the circuit compute the same root.
 */
export function deckMerkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) throw new Error("no leaves");
  let level = leaves.slice();
  const zero = new Uint8Array(32);
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(zero);
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(nodeHash(level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}

export interface MerkleProof {
  /** Sibling hashes from leaf to root. */
  path: Uint8Array[];
  /** Bit i = 1 if the node at level i is the RIGHT child. */
  indexBits: number[];
}

/** Build an inclusion proof for `index` (the private witness path). */
export function deckMerkleProof(
  leaves: Uint8Array[],
  index: number,
): MerkleProof {
  let level = leaves.slice();
  const zero = new Uint8Array(32);
  const path: Uint8Array[] = [];
  const indexBits: number[] = [];
  let idx = index;
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(zero);
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    path.push(level[siblingIdx]);
    indexBits.push(isRight ? 1 : 0);
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(nodeHash(level[i], level[i + 1]));
    level = next;
    idx = Math.floor(idx / 2);
  }
  return { path, indexBits };
}

/** Verify an inclusion proof off-chain (the same relation the circuit enforces). */
export function verifyMerkleProof(
  leaf: Uint8Array,
  proof: MerkleProof,
  root: Uint8Array,
): boolean {
  let h = leaf;
  for (let i = 0; i < proof.path.length; i++) {
    h =
      proof.indexBits[i] === 1
        ? nodeHash(proof.path[i], h)
        : nodeHash(h, proof.path[i]);
  }
  return bytesEqual(h, root);
}

// ---- Pluggable prover/verifier -------------------------------------------------

export interface CardWitness {
  salt: Uint8Array;
  proof: MerkleProof;
}

/**
 * A Groth16 prover for the card-in-deck circuit. Real implementations wrap snarkjs with
 * the trusted-setup proving key. {@link buildPublicInputs} produces the public inputs to
 * pass alongside the returned proof to `zk_verifier::verify_circuit_proof`.
 */
export interface CardProver {
  readonly circuitName: string;
  prove(stmt: CardStatement, witness: CardWitness): Promise<Uint8Array>;
}

/** Placeholder prover used until a trusted setup is wired in; throws with guidance. */
export class UnavailableProver implements CardProver {
  readonly circuitName = "card_in_deck";
  async prove(_stmt: CardStatement, _witness: CardWitness): Promise<Uint8Array> {
    throw new Error(
      "card_in_deck Groth16 proving requires a compiled circuit + trusted setup " +
        "(circom/snarkjs). Plug in a real CardProver; see CARD_IN_DECK_CIRCOM and " +
        "sui-tunnel-ts/docs/QUANTUM_POKER.md.",
    );
  }
}

/** circom source spec for the card-in-deck circuit (compile + trusted-setup at deploy). */
export const CARD_IN_DECK_CIRCOM = `pragma circom 2.1.0;
// Proves: leaf = H(position, card, salt) is included at \`position\` in the Merkle tree
// with public root \`deckRoot\`. Public: deckRoot, position, card. Private: salt, pathElements.
// Production uses Poseidon (SNARK-friendly) for H; the SDK Merkle here is illustrative
// (blake2b) — the deployed SDK must hash with the SAME function the circuit uses.
template CardInDeck(depth) {
    signal input deckRoot;            // public
    signal input position;            // public
    signal input card;                // public
    signal input salt;                // private
    signal input pathElements[depth]; // private
    signal input pathIndex[depth];    // private (0/1)
    // leaf = Poseidon(position, card, salt); fold up the path; assert == deckRoot
    // (full constraints omitted here — this is the circuit spec, not the compiled artifact)
}
component main { public [deckRoot, position, card] } = CardInDeck(6);`;
