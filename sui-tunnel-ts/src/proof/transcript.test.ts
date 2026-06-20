import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Transcript,
  transcriptLeaf,
  transcriptRoot,
  verifyTranscript,
  type ProofRecord,
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
import { toHex, fromHex } from "../core/bytes";

const kpA = keyPairFromSecret(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const kpB = keyPairFromSecret(
  Uint8Array.from({ length: 32 }, (_, i) => i + 33),
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
    { a: 100n, b: 100n },
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
    toHex(buildTranscript().root()),
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

const VKP_A = keyPairFromSecret(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const VKP_B = keyPairFromSecret(Uint8Array.from({ length: 32 }, (_, i) => i + 33));
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
  return { nonce, message, sigA: sign(message, VKP_A.secretKey), sigB: sign(message, VKP_B.secretKey) };
}

function vRecord(entries: ReturnType<typeof vEntry>[]): ProofRecord {
  const leaves = entries.map((e) => transcriptLeaf(e));
  return {
    tunnelId: VTID,
    root: toHex(transcriptRoot(leaves)),
    updateCount: entries.length,
    entries: entries.map((e) => ({
      nonce: e.nonce.toString(),
      message: toHex(e.message),
      sigA: toHex(e.sigA),
      sigB: toHex(e.sigB),
    })),
  };
}

function vRootOf(r: ProofRecord): string {
  return toHex(transcriptRoot(r.entries.map((e) => transcriptLeaf({
    nonce: BigInt(e.nonce),
    message: fromHex(e.message),
    sigA: fromHex(e.sigA),
    sigB: fromHex(e.sigB),
  }))));
}

test("verifyTranscript: valid conserving transcript passes every check", () => {
  const r = vRecord([vEntry(1n, 60n, 40n), vEntry(2n, 70n, 30n), vEntry(3n, 50n, 50n)]);
  const v = verifyTranscript(r, { ...VPARTIES, onchainRoot: r.root, lockedTotal: 100n });
  assert.equal(v.ok, true);
  assert.equal(v.rootMatches, true);
  assert.equal(v.allSigsValid, true);
  assert.equal(v.nonceMonotonic, true);
  assert.equal(v.balancesConserved, true);
  assert.equal(v.stepCount, 3);
});

test("verifyTranscript: a forged signature is detected (mutual authorization)", () => {
  const r = vRecord([vEntry(1n, 60n, 40n), vEntry(2n, 70n, 30n)]);
  const s = r.entries[0].sigA;
  r.entries[0].sigA = (s.slice(0, 2) === "00" ? "ff" : "00") + s.slice(2);
  const root = vRootOf(r);
  const v = verifyTranscript({ ...r, root }, { ...VPARTIES, onchainRoot: root });
  assert.equal(v.allSigsValid, false);
  assert.equal(v.steps[0].sigAValid, false);
  assert.equal(v.ok, false);
});

test("verifyTranscript: non-conserving balances are detected (no value created)", () => {
  const r = vRecord([vEntry(1n, 60n, 40n), vEntry(2n, 70n, 20n)]);
  const v = verifyTranscript(r, { ...VPARTIES, onchainRoot: r.root });
  assert.equal(v.allSigsValid, true);
  assert.equal(v.balancesConserved, false);
  assert.equal(v.ok, false);
});

test("verifyTranscript: non-monotonic nonce is detected (no replay/reorder)", () => {
  const r = vRecord([vEntry(2n, 60n, 40n), vEntry(2n, 60n, 40n)]);
  const v = verifyTranscript(r, { ...VPARTIES, onchainRoot: r.root });
  assert.equal(v.nonceMonotonic, false);
  assert.equal(v.ok, false);
});

test("verifyTranscript: root mismatch vs the on-chain anchor is detected", () => {
  const r = vRecord([vEntry(1n, 60n, 40n)]);
  const v = verifyTranscript(r, { ...VPARTIES, onchainRoot: "00".repeat(32) });
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
    { a: 100n, b: 100n },
  );
  const tr = new Transcript(t.tunnelId);
  t.onUpdate = (u) => tr.append(u);
  const vmoves: PaymentMove[] = [
    { from: "A", amount: 10n },
    { from: "B", amount: 5n },
    { from: "A", amount: 3n },
  ];
  for (const m of vmoves) t.step(m, m.from, { timestamp: 1000n });

  const rec = tr.toRecord();
  const v = verifyTranscript(rec, {
    partyA: { publicKey: VKP_A.publicKey, scheme: SignatureScheme.ED25519 },
    partyB: { publicKey: VKP_B.publicKey, scheme: SignatureScheme.ED25519 },
    onchainRoot: toHex(tr.root()),
    lockedTotal: 200n,
  });
  assert.equal(v.ok, true);
  assert.equal(v.stepCount, 3);
});
