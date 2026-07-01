import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Transcript,
  transcriptLeaf,
  transcriptRoot,
  verifyTranscript,
  verifyTranscriptEntries,
  type TranscriptEntry,
} from "./transcript";
import { OffchainTunnel } from "../core/tunnel";
import {
  keyPairFromSecret,
  sign,
  ed25519Address,
  SignatureScheme,
} from "../core/crypto";
import { serializeStateUpdate } from "../core/wire";
import { PaymentsProtocol, PaymentMove } from "../protocol/payments";
import { toHex } from "../core/bytes";
import { encodeSettleBody } from "./settleBinary";

const kpA = keyPairFromSecret(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const kpB = keyPairFromSecret(
  Uint8Array.from({ length: 32 }, (_, i) => i + 33)
);
const moves: PaymentMove[] = [
  { from: "A", amount: 10n },
  { from: "B", amount: 5n },
  { from: "A", amount: 3n },
];

function buildTranscript(): Transcript {
  const t = OffchainTunnel.selfPlay(
    new PaymentsProtocol(),
    "0x" + "55".repeat(32),
    kpA,
    kpB,
    ed25519Address(kpA.publicKey),
    ed25519Address(kpB.publicKey),
    { a: 100n, b: 100n }
  );
  const tr = new Transcript(t.tunnelId);
  t.onUpdate = (u) => tr.append(u);
  for (const m of moves) t.step(m, m.from, { timestamp: 1000n });
  return tr;
}

test("empty transcript root is 32 zero bytes", () => {
  assert.equal(toHex(transcriptRoot([])), "00".repeat(32));
});

test("transcript accumulates updates and yields a 32-byte root", () => {
  const tr = buildTranscript();
  assert.equal(tr.length, 3);
  assert.equal(tr.root().length, 32);
});

test("transcript root is deterministic and reproducible (replay)", () => {
  assert.equal(
    toHex(buildTranscript().root()),
    toHex(buildTranscript().root())
  );
});

test("toRecord captures the full transcript + root + count", () => {
  const tr = buildTranscript();
  const rec = tr.toRecord({
    finalBalances: { a: 98n, b: 102n },
    closedAtMs: 123,
  });
  assert.equal(rec.updateCount, 3);
  assert.equal(rec.entries.length, 3);
  assert.equal(rec.root, toHex(tr.root()));
  assert.equal(rec.finalBalances?.a, "98");
  assert.equal(rec.entries[0].nonce, "1");
});

// ============================================
// verifyTranscript tests
// ============================================

const VKP_A = keyPairFromSecret(
  Uint8Array.from({ length: 32 }, (_, i) => i + 1)
);
const VKP_B = keyPairFromSecret(
  Uint8Array.from({ length: 32 }, (_, i) => i + 33)
);
const VTID = "0x" + "55".repeat(32);
const VPARTIES = {
  partyA: { publicKey: VKP_A.publicKey, scheme: SignatureScheme.ED25519 },
  partyB: { publicKey: VKP_B.publicKey, scheme: SignatureScheme.ED25519 },
};

function vEntry(nonce: bigint, a: bigint, b: bigint) {
  const message = serializeStateUpdate({
    tunnelId: VTID,
    stateHash: new Uint8Array(32),
    nonce,
    timestamp: 1000n,
    partyABalance: a,
    partyBBalance: b,
  });
  return {
    nonce,
    message,
    sigA: sign(message, VKP_A.secretKey),
    sigB: sign(message, VKP_B.secretKey),
  };
}

// verifyTranscript checks the per-entry co-sigs + recomputed root, so the settle body's
// own settlement co-sigs are irrelevant here — use dummy 64-byte sigs. The body's
// transcriptRoot defaults to the Merkle root over `entries` (what the on-chain anchor
// would hold); pass `root` to test a deliberate mismatch.
function vBlob(
  entries: TranscriptEntry[],
  opts?: { root?: Uint8Array }
): Uint8Array {
  const root = opts?.root ?? transcriptRoot(entries.map(transcriptLeaf));
  return encodeSettleBody({
    tunnelId: VTID,
    partyABalance: 0n,
    partyBBalance: 0n,
    finalNonce: 0n,
    timestamp: 1000n,
    transcriptRoot: root,
    sigA: new Uint8Array(64),
    sigB: new Uint8Array(64),
    entries: entries.map((e) => ({
      message: e.message,
      sigA: e.sigA,
      sigB: e.sigB,
    })),
  });
}

test("verifyTranscript: valid conserving transcript passes every check", () => {
  const entries = [
    vEntry(1n, 60n, 40n),
    vEntry(2n, 70n, 30n),
    vEntry(3n, 50n, 50n),
  ];
  const blob = vBlob(entries);
  const v = verifyTranscript(blob, {
    ...VPARTIES,
    onchainRoot: toHex(transcriptRoot(entries.map(transcriptLeaf))),
    lockedTotal: 100n,
  });
  assert.equal(v.ok, true);
  assert.equal(v.rootMatches, true);
  assert.equal(v.allSigsValid, true);
  assert.equal(v.nonceMonotonic, true);
  assert.equal(v.balancesConserved, true);
  assert.equal(v.stepCount, 3);
});

// The bot-owned path: the explorer serves reassembled chunks with NO 229-byte header, so the
// verifier reads the root from the on-chain row. Entries-only bytes == a settle body minus its
// header, which is exactly what the streamed chunks concatenate to.
test("verifyTranscriptEntries: header-less chunks verify against the on-chain row root", () => {
  const entries = [
    vEntry(1n, 60n, 40n),
    vEntry(2n, 70n, 30n),
    vEntry(3n, 50n, 50n),
  ];
  const root = transcriptRoot(entries.map(transcriptLeaf));
  const entriesOnly = vBlob(entries, { root }).slice(229);
  const v = verifyTranscriptEntries(entriesOnly, {
    ...VPARTIES,
    onchainRoot: toHex(root),
    lockedTotal: 100n,
  });
  assert.equal(v.ok, true);
  assert.equal(v.rootMatches, true);
  assert.equal(v.allSigsValid, true);
  assert.equal(v.stepCount, 3);
});

test("verifyTranscriptEntries: root mismatch vs the on-chain anchor is detected", () => {
  const entries = [vEntry(1n, 60n, 40n), vEntry(2n, 70n, 30n)];
  const entriesOnly = vBlob(entries).slice(229);
  const v = verifyTranscriptEntries(entriesOnly, {
    ...VPARTIES,
    onchainRoot: "00".repeat(32), // wrong anchor => must fail, no header root to hide behind
  });
  assert.equal(v.rootMatches, false);
  assert.equal(v.ok, false);
});

// Cross-language root parity for the CHUNK path: reproduce the exact fixture the Rust bot pins in
// tunnel-harness `transcript_root_matches_the_ts_merkle_fixture`, then prove (a) TS recomputes the
// same root and (b) the header-less reassembled chunks verify against that on-chain root. This is
// the "bot root == recomputed root == on-chain root" contract for entries-only chunks.
const PARITY_TID = "0x" + "55".repeat(32);
function fill(byte: number, n: number): Uint8Array {
  return new Uint8Array(n).fill(byte);
}
function parityEntry(
  nonce: bigint,
  a: bigint,
  b: bigint,
  sigAByte: number,
  sigBByte: number
): TranscriptEntry {
  // Mirrors Rust `parity_entry` (Seat::A: sig_a=proposer, sig_b=responder).
  const stateHash = Uint8Array.from(
    { length: 32 },
    (_, i) => (i + Number(nonce)) & 0xff
  );
  const message = serializeStateUpdate({
    tunnelId: PARITY_TID,
    stateHash,
    nonce,
    timestamp: 1000n + nonce,
    partyABalance: a,
    partyBBalance: b,
  });
  return { nonce, message, sigA: fill(sigAByte, 64), sigB: fill(sigBByte, 64) };
}

test("cross-language: TS root + entries-only verify match the Rust golden fixture", () => {
  const entries = [
    parityEntry(1n, 90n, 110n, 0x11, 0x22),
    parityEntry(2n, 95n, 105n, 0x33, 0x44),
    parityEntry(3n, 80n, 120n, 0x55, 0x66),
  ];
  // The exact root the Rust recorder computes over these entries (tunnel-harness golden).
  const RUST_ROOT =
    "1d96600288a81c30db9384dca7be6d9904bfeb062efd28b9d74bd1fb2d61df30";
  assert.equal(toHex(transcriptRoot(entries.map(transcriptLeaf))), RUST_ROOT);

  // The header-less bytes the explorer reassembles from the bot's chunks (body minus 229B header).
  const entriesOnly = encodeSettleBody({
    tunnelId: PARITY_TID,
    partyABalance: 0n,
    partyBBalance: 0n,
    finalNonce: 0n,
    timestamp: 0n,
    transcriptRoot: fill(0, 32),
    sigA: fill(0, 64),
    sigB: fill(0, 64),
    entries: entries.map((e) => ({
      message: e.message,
      sigA: e.sigA,
      sigB: e.sigB,
    })),
  }).slice(229);
  const v = verifyTranscriptEntries(entriesOnly, {
    ...VPARTIES,
    onchainRoot: RUST_ROOT,
  });
  // Root recomputed from the chunk bytes matches the on-chain anchor (sigs are fixture bytes, so
  // allSigsValid is expectedly false — the root parity is what this golden asserts).
  assert.equal(v.rootMatches, true);
  assert.equal(v.stepCount, 3);
});

test("verifyTranscript: a forged signature is detected (mutual authorization)", () => {
  // Forge the sig BEFORE computing the root, so the leaf commits to the bad sig and
  // only the per-entry verify trips — rootMatches stays true.
  const e0 = vEntry(1n, 60n, 40n);
  e0.sigA = Uint8Array.from(e0.sigA);
  e0.sigA[0] ^= 0xff;
  const entries = [e0, vEntry(2n, 70n, 30n)];
  const root = transcriptRoot(entries.map(transcriptLeaf));
  const v = verifyTranscript(vBlob(entries, { root }), {
    ...VPARTIES,
    onchainRoot: toHex(root),
  });
  assert.equal(v.allSigsValid, false);
  assert.equal(v.steps[0].sigAValid, false);
  assert.equal(v.ok, false);
});

test("verifyTranscript: non-conserving balances are detected (no value created)", () => {
  const entries = [vEntry(1n, 60n, 40n), vEntry(2n, 70n, 20n)];
  const v = verifyTranscript(vBlob(entries), {
    ...VPARTIES,
    onchainRoot: toHex(transcriptRoot(entries.map(transcriptLeaf))),
  });
  assert.equal(v.allSigsValid, true);
  assert.equal(v.balancesConserved, false);
  assert.equal(v.ok, false);
});

test("verifyTranscript: non-monotonic nonce is detected (no replay/reorder)", () => {
  const entries = [vEntry(2n, 60n, 40n), vEntry(2n, 60n, 40n)];
  const v = verifyTranscript(vBlob(entries), {
    ...VPARTIES,
    onchainRoot: toHex(transcriptRoot(entries.map(transcriptLeaf))),
  });
  assert.equal(v.nonceMonotonic, false);
  assert.equal(v.ok, false);
});

test("verifyTranscript: root mismatch vs the on-chain anchor is detected", () => {
  const entries = [vEntry(1n, 60n, 40n)];
  const v = verifyTranscript(vBlob(entries), {
    ...VPARTIES,
    onchainRoot: "00".repeat(32),
  });
  assert.equal(v.rootMatches, false);
  assert.equal(v.ok, false);
});

test("verifyTranscript: a real self-play transcript verifies end-to-end", () => {
  const t = OffchainTunnel.selfPlay(
    new PaymentsProtocol(),
    VTID,
    VKP_A,
    VKP_B,
    ed25519Address(VKP_A.publicKey),
    ed25519Address(VKP_B.publicKey),
    { a: 100n, b: 100n }
  );
  const tr = new Transcript(t.tunnelId);
  t.onUpdate = (u) => tr.append(u);
  const vmoves: PaymentMove[] = [
    { from: "A", amount: 10n },
    { from: "B", amount: 5n },
    { from: "A", amount: 3n },
  ];
  for (const m of vmoves) t.step(m, m.from, { timestamp: 1000n });

  const v = verifyTranscript(vBlob(tr.rawEntries(), { root: tr.root() }), {
    partyA: { publicKey: VKP_A.publicKey, scheme: SignatureScheme.ED25519 },
    partyB: { publicKey: VKP_B.publicKey, scheme: SignatureScheme.ED25519 },
    onchainRoot: toHex(tr.root()),
    lockedTotal: 200n,
  });
  assert.equal(v.ok, true);
  assert.equal(v.stepCount, 3);
});

// ============================================
// verifyTranscript binary blob
// ============================================

function selfPlayBlob(t: Transcript): Uint8Array {
  return encodeSettleBody({
    tunnelId: t.tunnelId,
    partyABalance: 100n,
    partyBBalance: 100n,
    finalNonce: 3n,
    timestamp: 1000n,
    transcriptRoot: t.root(),
    sigA: new Uint8Array(64),
    sigB: new Uint8Array(64),
    entries: t.rawEntries(),
  });
}

const SELFPLAY_PARTIES = {
  partyA: { publicKey: kpA.publicKey, scheme: SignatureScheme.ED25519 },
  partyB: { publicKey: kpB.publicKey, scheme: SignatureScheme.ED25519 },
};

test("verifyTranscript accepts a binary blob and verifies it ok", () => {
  const t = buildTranscript();
  const blob = selfPlayBlob(t);
  const res = verifyTranscript(blob, {
    ...SELFPLAY_PARTIES,
    onchainRoot: toHex(t.root()),
  });
  assert.equal(res.ok, true);
});

test("verifyTranscript on a tampered entry sig reports not ok", () => {
  const t = buildTranscript();
  const blob = selfPlayBlob(t);
  blob[blob.length - 1] ^= 0xff; // flip a byte in the last entry sig
  const res = verifyTranscript(blob, {
    ...SELFPLAY_PARTIES,
    onchainRoot: toHex(t.root()),
  });
  assert.equal(res.ok, false);
});
