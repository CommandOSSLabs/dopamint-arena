import { test } from "node:test";
import assert from "node:assert/strict";
import { Transcript, transcriptRoot } from "./transcript";
import { OffchainTunnel } from "../core/tunnel";
import { keyPairFromSecret, ed25519Address } from "../core/crypto";
import { PaymentsProtocol, PaymentMove } from "../protocol/payments";
import { toHex } from "../core/bytes";

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
