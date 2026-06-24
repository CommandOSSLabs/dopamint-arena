import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519Address, generateKeyPair } from "../core/crypto";
import { OffchainTunnel, verifyCoSignedUpdate } from "../core/tunnel";
import { mulberry32 } from "../sim/rng";
import { Party } from "./Protocol";
import {
  evaluate5,
  PokerMove,
  PokerState,
  QuantumPokerProtocol,
} from "./quantumPoker";

test("evaluate5 ranks hands correctly", () => {
  const straightFlush = evaluate5([8, 9, 10, 11, 12]); // suit 0, ranks 8-12
  const quads = evaluate5([0, 13, 26, 39, 1]); // four rank-0
  const pair = evaluate5([0, 13, 28, 42, 9]); // two rank-0
  const high = evaluate5([0, 14, 28, 42, 9]); // ranks 0,1,2,3,9 mixed suits
  assert.ok(straightFlush > quads);
  assert.ok(quads > pair);
  assert.ok(pair > high);
});

test("evaluate5 rejects malformed hands (duplicate / out-of-range cards)", () => {
  assert.throws(() => evaluate5([0, 0, 28, 42, 9]), /duplicate/);
  assert.throws(() => evaluate5([0, 1, 2, 3, 52]), /out of range/);
  assert.throws(() => evaluate5([0, 1, 2, 3, -1]), /out of range/);
});

test("commit-reveal: a wrong seed reveal is rejected", () => {
  const p = new QuantumPokerProtocol();
  let s = p.initialState({
    tunnelId: "0xaa",
    initialBalances: { a: 1000n, b: 1000n },
  });
  s = p.applyMove(
    s,
    { kind: "commit", value: Uint8Array.of(1), salt: new Uint8Array(16) },
    "A"
  );
  s = p.applyMove(
    s,
    {
      kind: "commit",
      value: Uint8Array.of(2),
      salt: new Uint8Array(16).fill(2),
    },
    "B"
  );
  assert.equal(s.phase, "reveal");
  // wrong value -> commitment mismatch
  assert.throws(() =>
    p.applyMove(
      s,
      {
        kind: "reveal_seed",
        value: Uint8Array.of(9),
        salt: new Uint8Array(16),
      },
      "A"
    )
  );
  // correct reveal works
  const s2 = p.applyMove(
    s,
    { kind: "reveal_seed", value: Uint8Array.of(1), salt: new Uint8Array(16) },
    "A"
  );
  assert.ok(s2.revealedA);
});

test("hole cards are hidden pre-showdown: encodeState carries commitments, not values", () => {
  const p = new QuantumPokerProtocol();
  let s = p.initialState({
    tunnelId: "0xab",
    initialBalances: { a: 1000n, b: 1000n },
  });
  s = p.applyMove(
    s,
    { kind: "commit", value: Uint8Array.of(1), salt: new Uint8Array(16) },
    "A"
  );
  s = p.applyMove(
    s,
    {
      kind: "commit",
      value: Uint8Array.of(2),
      salt: new Uint8Array(16).fill(2),
    },
    "B"
  );
  s = p.applyMove(
    s,
    { kind: "reveal_seed", value: Uint8Array.of(1), salt: new Uint8Array(16) },
    "A"
  );
  s = p.applyMove(
    s,
    {
      kind: "reveal_seed",
      value: Uint8Array.of(2),
      salt: new Uint8Array(16).fill(2),
    },
    "B"
  );
  assert.equal(s.phase, "bet");
  assert.ok(s.holeCommitA && s.holeCommitA.length === 2);
  assert.ok(s.holeA && s.holeA.length === 2); // dealt locally
  assert.ok(s.shownHoleA === null); // not revealed -> not in encodeState
  // encodeState is deterministic
  assert.equal(
    Buffer.from(p.encodeState(s)).toString("hex"),
    Buffer.from(p.encodeState(s)).toString("hex")
  );
});

test("full self-play game: balances conserved every step, hands complete, updates settle", () => {
  const rng = mulberry32(123);
  const a = generateKeyPair();
  const b = generateKeyPair();
  const t = OffchainTunnel.selfPlay(
    new QuantumPokerProtocol(20n),
    "0x" + "44".repeat(32),
    a,
    b,
    ed25519Address(a.publicKey),
    ed25519Address(b.publicKey),
    { a: 10_000n, b: 10_000n }
  );
  const total = t.total;
  let steps = 0;
  while (steps < 6000 && t.state.phase !== "done") {
    let moved = false;
    for (const party of ["A", "B"] as Party[]) {
      const m = t.protocol.randomMove(t.state, party, rng);
      if (m) {
        t.step(m as PokerMove, party);
        moved = true;
        steps++;
        const bal = t.protocol.balances(t.state);
        assert.equal(bal.a + bal.b, total);
        break;
      }
    }
    if (!moved) break;
  }
  assert.ok(
    (t.state as PokerState).handNo > 0n,
    `hands: ${(t.state as PokerState).handNo}`
  );
  assert.ok(t.latest);
  assert.ok(
    verifyCoSignedUpdate(
      t.latest!,
      { publicKey: t.partyA.publicKey, scheme: t.partyA.scheme },
      { publicKey: t.partyB.publicKey, scheme: t.partyB.scheme }
    )
  );
});
