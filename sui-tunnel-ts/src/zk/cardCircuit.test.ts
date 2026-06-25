import { test } from "node:test";
import assert from "node:assert/strict";
import { u64ToScalar, concatScalars } from "./scalars";
import {
  buildPublicInputs,
  cardLeaf,
  deckMerkleRoot,
  deckMerkleProof,
  verifyMerkleProof,
  UnavailableProver,
} from "./cardCircuit";
import { toHex } from "../core/bytes";

// Golden shared with sui_tunnel/tests/zk_inputs_xcheck_tests.move.
const G_PUBLIC_INPUTS =
  "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2005000000000000000000000000000000000000000000000000000000000000002a00000000000000000000000000000000000000000000000000000000000000";

test("u64ToScalar is little-endian, 32 bytes", () => {
  const s = u64ToScalar(5);
  assert.equal(s.length, 32);
  assert.equal(s[0], 5);
  assert.equal(s[1], 0);
});

test("buildPublicInputs matches Move concat_scalars golden", () => {
  const deckRoot = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  assert.equal(
    toHex(buildPublicInputs({ deckRoot, position: 5, card: 42 })),
    G_PUBLIC_INPUTS
  );
});

test("concatScalars rejects non-32-byte and >8 scalars", () => {
  assert.throws(() => concatScalars([new Uint8Array(31)]));
  assert.throws(() =>
    concatScalars(Array.from({ length: 9 }, () => new Uint8Array(32)))
  );
});

test("deck Merkle root + inclusion proof verify; tamper fails", () => {
  const leaves = Array.from({ length: 52 }, (_, i) =>
    cardLeaf(
      i,
      i,
      Uint8Array.from({ length: 16 }, () => i & 0xff)
    )
  );
  const root = deckMerkleRoot(leaves);
  for (const idx of [0, 7, 25, 51]) {
    const proof = deckMerkleProof(leaves, idx);
    assert.ok(verifyMerkleProof(leaves[idx], proof, root), `idx ${idx}`);
  }
  // wrong leaf for a given proof must fail
  const p7 = deckMerkleProof(leaves, 7);
  assert.ok(!verifyMerkleProof(leaves[8], p7, root));
});

test("cardLeaf is deterministic and salt-sensitive", () => {
  const s = Uint8Array.from({ length: 16 }, (_, i) => i);
  assert.equal(toHex(cardLeaf(3, 42, s)), toHex(cardLeaf(3, 42, s)));
  const s2 = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  assert.notEqual(toHex(cardLeaf(3, 42, s)), toHex(cardLeaf(3, 42, s2)));
});

test("UnavailableProver throws with deployment guidance", async () => {
  await assert.rejects(
    () =>
      new UnavailableProver().prove(
        { deckRoot: new Uint8Array(32), position: 0, card: 0 },
        { salt: new Uint8Array(16), proof: { path: [], indexBits: [] } }
      ),
    /trusted setup/
  );
});
