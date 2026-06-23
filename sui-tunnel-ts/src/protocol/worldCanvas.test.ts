import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorldCanvasProtocol,
  type WorldCanvasMove,
  type WorldCanvasState,
} from "./worldCanvas";
import { toHex } from "../core/bytes";
import { OffchainTunnel, verifyCoSignedUpdate } from "../core/tunnel";
import { generateKeyPair, ed25519Address } from "../core/crypto";

const proto = new WorldCanvasProtocol();
const ctx = { tunnelId: "0xab", initialBalances: { a: 100n, b: 100n } };

/** A fixed paint stream — both painters, negative coords, edge cells, color 0. */
const SEQUENCE: { mv: WorldCanvasMove; by: "A" | "B" }[] = [
  { mv: { cx: 0n, cy: 0n, x: 1, y: 2, color: 3 }, by: "A" },
  { mv: { cx: -1n, cy: 4n, x: 255, y: 0, color: 15 }, by: "B" },
  { mv: { cx: 7n, cy: -3n, x: 128, y: 64, color: 0 }, by: "A" },
  { mv: { cx: 0n, cy: 0n, x: 1, y: 2, color: 9 }, by: "B" },
];

/** Golden digest after replaying SEQUENCE — pins the canonical paint encoding. */
const GOLDEN_DIGEST =
  "dfd896bb87edefc3ad4bca4f271ac358602ca77724f61e2cbffc3b4e44e4ba83";

function replay(seq = SEQUENCE): WorldCanvasState {
  let s = proto.initialState(ctx);
  for (const { mv, by } of seq) s = proto.applyMove(s, mv, by);
  return s;
}

test("initialState is a zero digest, zero count, and locked balances", () => {
  const s = proto.initialState(ctx);
  assert.equal(s.count, 0n);
  assert.equal(s.lastPainter, null);
  assert.equal(s.balanceA, 100n);
  assert.equal(s.balanceB, 100n);
  assert.equal(s.total, 200n);
  assert.equal(s.rollingDigest.length, 32);
  assert.equal(toHex(s.rollingDigest), "00".repeat(32));
});

test("each paint folds the digest and increments the count", () => {
  // The core 1-paint = 1-state-change invariant: N paints yield N distinct
  // digests, so the co-signed tunnel state hash changes on every single paint.
  let s = proto.initialState(ctx);
  const seen = new Set<string>([toHex(s.rollingDigest)]);
  for (let i = 0; i < 64; i++) {
    s = proto.applyMove(s, { cx: 0n, cy: 0n, x: 0, y: 0, color: 0 }, "A");
    assert.equal(s.count, BigInt(i + 1));
    const digest = toHex(s.rollingDigest);
    assert.ok(!seen.has(digest), `digest repeated at paint ${i}`);
    seen.add(digest);
  }
  // Even a fixed cell+color repainted forever keeps changing the state hash.
  assert.equal(seen.size, 65);
  assert.equal(s.lastPainter, "A");
});

test("overpaint: re-painting a cell is a fresh co-signed move that updates its owner", () => {
  // OVERPAINT is allowed — there are no locked cells. Re-painting an existing
  // cell (by anyone, any color) is a full move: count++, the digest changes, and
  // the cell's owner (lastPainter) updates to the latest painter.
  let s = proto.initialState(ctx);
  const cell: WorldCanvasMove = { cx: 3n, cy: -2n, x: 10, y: 10, color: 5 };

  s = proto.applyMove(s, cell, "A");
  assert.equal(s.count, 1n);
  assert.equal(s.lastPainter, "A");
  const afterFirst = toHex(s.rollingDigest);

  // B paints over A's cell with a new color: accepted, advances, owner flips to B.
  s = proto.applyMove(s, { ...cell, color: 8 }, "B");
  assert.equal(s.count, 2n);
  assert.equal(s.lastPainter, "B");
  assert.notEqual(toHex(s.rollingDigest), afterFirst);

  // Even re-painting the SAME cell with the SAME color+painter is not a no-op:
  // the rolling digest still strictly changes, so it stays one co-signed move.
  const beforeRepaint = toHex(s.rollingDigest);
  s = proto.applyMove(s, { ...cell, color: 8 }, "B");
  assert.equal(s.count, 3n);
  assert.equal(s.lastPainter, "B");
  assert.notEqual(toHex(s.rollingDigest), beforeRepaint);
});

test("digest is order- and painter-sensitive", () => {
  const s = proto.initialState(ctx);
  const cell: WorldCanvasMove = { cx: 2n, cy: 2n, x: 3, y: 3, color: 5 };
  // same paint, different painter -> different digest
  const byA = proto.applyMove(s, cell, "A");
  const byB = proto.applyMove(s, cell, "B");
  assert.notEqual(toHex(byA.rollingDigest), toHex(byB.rollingDigest));
  // same first paint, different second -> different digest (order matters)
  const next1 = proto.applyMove(byA, { ...cell, color: 6 }, "B");
  const next2 = proto.applyMove(byA, { ...cell, color: 7 }, "B");
  assert.notEqual(toHex(next1.rollingDigest), toHex(next2.rollingDigest));
});

test("golden determinism: a fixed paint stream pins the digest", () => {
  const a = replay();
  const b = replay();
  // Two independent replays agree (both parties derive the same co-signed hash).
  assert.equal(toHex(a.rollingDigest), toHex(b.rollingDigest));
  assert.equal(a.count, 4n);
  // ...and match the recorded golden (catches any paint-encoding drift).
  assert.equal(toHex(a.rollingDigest), GOLDEN_DIGEST);
});

test("encodeState is deterministic, fixed-size, and changes with state", () => {
  const s0 = proto.initialState(ctx);
  const s1 = proto.applyMove(s0, { cx: 0n, cy: 0n, x: 1, y: 1, color: 2 }, "A");
  const e0 = proto.encodeState(s0);
  const e1 = proto.encodeState(s1);
  // Deterministic: same state -> same bytes.
  assert.equal(toHex(e0), toHex(proto.encodeState(s0)));
  // Sensitive: every paint moves the encoding.
  assert.notEqual(toHex(e0), toHex(e1));
  // Fixed size regardless of how many paints have landed.
  const sMany = replay();
  assert.equal(e1.length, proto.encodeState(sMany).length);
});

test("applyMove rejects out-of-range cells, colors, and coordinates", () => {
  const s = proto.initialState(ctx);
  assert.throws(() => proto.applyMove(s, { cx: 0n, cy: 0n, x: -1, y: 0, color: 0 }, "A"));
  assert.throws(() => proto.applyMove(s, { cx: 0n, cy: 0n, x: 256, y: 0, color: 0 }, "A"));
  assert.throws(() => proto.applyMove(s, { cx: 0n, cy: 0n, x: 0, y: 256, color: 0 }, "A"));
  assert.throws(() => proto.applyMove(s, { cx: 0n, cy: 0n, x: 0, y: 0, color: 16 }, "A"));
  assert.throws(() => proto.applyMove(s, { cx: 0n, cy: 0n, x: 0, y: 0, color: -1 }, "A"));
  assert.throws(() =>
    proto.applyMove(s, { cx: 1n << 63n, cy: 0n, x: 0, y: 0, color: 0 }, "A"),
  );
});

test("applyMove is pure (does not mutate input state)", () => {
  const s = proto.initialState(ctx);
  const before = toHex(s.rollingDigest);
  proto.applyMove(s, { cx: 5n, cy: 5n, x: 9, y: 9, color: 9 }, "A");
  assert.equal(s.count, 0n);
  assert.equal(s.lastPainter, null);
  assert.equal(toHex(s.rollingDigest), before);
});

test("balances stay locked and isTerminal is false over a long random stream", () => {
  let s = proto.initialState(ctx);
  let x = 0.1234;
  const rng = () => (x = (x * 16807) % 1);
  for (let i = 0; i < 500; i++) {
    const by = i % 2 === 0 ? "A" : "B";
    const m = proto.randomMove(s, by, rng);
    assert.ok(m, "randomMove should always produce a paint below the cap");
    s = proto.applyMove(s, m!, by);
    const bal = proto.balances(s);
    assert.equal(bal.a + bal.b, 200n);
    assert.equal(bal.a, 100n);
    assert.equal(bal.b, 100n);
    assert.ok(!proto.isTerminal(s));
  }
  assert.equal(s.count, 500n);
});

test("isTerminal flips only at the configured cap", () => {
  const tiny = new WorldCanvasProtocol({ cap: 2n });
  let s = tiny.initialState(ctx);
  assert.ok(!tiny.isTerminal(s));
  s = tiny.applyMove(s, { cx: 0n, cy: 0n, x: 0, y: 0, color: 0 }, "A");
  assert.ok(!tiny.isTerminal(s));
  s = tiny.applyMove(s, { cx: 0n, cy: 0n, x: 0, y: 0, color: 1 }, "B");
  assert.ok(tiny.isTerminal(s));
  // No paint is accepted past the cap.
  assert.throws(() =>
    tiny.applyMove(s, { cx: 0n, cy: 0n, x: 0, y: 0, color: 2 }, "A"),
  );
  assert.equal(tiny.randomMove(s, "A", Math.random), null);
});

test("end-to-end self-play tunnel: every paint is a verified co-signed update", () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const t = OffchainTunnel.selfPlay(
    new WorldCanvasProtocol(),
    "0x" + "44".repeat(32),
    a,
    b,
    ed25519Address(a.publicKey),
    ed25519Address(b.publicKey),
    { a: 1n, b: 1n },
  );
  // Human (A) and agent (B) paints both co-sign through the same tunnel.
  for (const { mv, by } of SEQUENCE) {
    const r = t.step(mv, by, { mode: "full" });
    assert.ok(r.verified, "co-signed paint must verify both signatures");
  }
  const s = t.state as WorldCanvasState;
  assert.equal(s.count, 4n);
  assert.equal(toHex(s.rollingDigest), GOLDEN_DIGEST);
  assert.equal(s.balanceA + s.balanceB, 2n);

  assert.ok(t.latest);
  assert.ok(
    verifyCoSignedUpdate(
      t.latest!,
      { publicKey: t.partyA.publicKey, scheme: t.partyA.scheme },
      { publicKey: t.partyB.publicKey, scheme: t.partyB.scheme },
    ),
  );
});
