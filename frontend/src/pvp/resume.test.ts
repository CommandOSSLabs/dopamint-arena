import test from "node:test";
import assert from "node:assert/strict";

// Minimal localStorage + window fakes (must exist before importing resume.ts).
class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
(globalThis as Record<string, unknown>).localStorage = new FakeStorage();
(globalThis as Record<string, unknown>).window = { addEventListener() {} };

const {
  stringifyWithBigint,
  parseWithBigint,
  toWireCoSigned,
  fromWireCoSigned,
  writeResumeRecord,
  flushResumeWrites,
  readResumeRecord,
  clearResumeRecord,
  listActiveTunnels,
  evictExpiredRecords,
  hasResumableMatch,
  keypairFromSecretHex,
} = await import("./resume");
const { OffchainTunnel } = await import("sui-tunnel-ts/core/tunnel");
const { generateKeyPair } = await import("sui-tunnel-ts/core/crypto");
const { toHex } = await import("sui-tunnel-ts/core/bytes");

test("keypairFromSecretHex rebuilds a key that signs identically to the original", () => {
  const kp = generateKeyPair();
  const restored = keypairFromSecretHex(toHex(kp.secretKey));
  assert.deepEqual(Uint8Array.from(restored.secretKey), kp.secretKey);
  assert.deepEqual(Uint8Array.from(restored.publicKey), kp.publicKey);
  assert.equal(restored.scheme, kp.scheme);
});

test("selfEphemeralSecretHex survives the resume-record write/read round-trip", () => {
  const tid = `0x${"5a".repeat(32)}`;
  const secretHex = toHex(generateKeyPair().secretKey);
  writeResumeRecord({
    matchId: "m",
    tunnelId: tid,
    role: "A",
    game: "ttt",
    opponentWallet: "0xb",
    opponentPubkeyHex: "ab",
    selfEphemeralSecretHex: secretHex,
    latestCoSigned: toWireCoSigned(sampleCoSigned(tid)),
    latestState: { board: [0] },
    updatedAt: 1,
  });
  flushResumeWrites();
  assert.equal(readResumeRecord(tid)?.selfEphemeralSecretHex, secretHex);
  clearResumeRecord(tid);
});

test("bigint round-trips through stringify/parse", () => {
  const v = { a: 10n, nested: [1n, { b: 2n }], s: "x" };
  assert.deepEqual(parseWithBigint(stringifyWithBigint(v)), v);
});

test("CoSignedUpdate survives the wire conversion byte-for-byte", () => {
  const ka = generateKeyPair(),
    kb = generateKeyPair();
  const tid = `0x${"31".repeat(32)}`;
  const sp = OffchainTunnel.selfPlay(
    counterProto(),
    tid,
    ka,
    kb,
    "0xA",
    "0xB",
    { a: 1000n, b: 1000n },
  );
  sp.step(1, "A");
  const u = sp.latest!;
  const back = fromWireCoSigned(toWireCoSigned(u));
  // Normalize to plain Uint8Array so deepEqual compares bytes, not Buffer-vs-Uint8Array prototypes.
  const bytes = (b: Uint8Array) => Uint8Array.from(b);
  assert.equal(back.update.nonce, u.update.nonce);
  assert.equal(back.update.partyABalance, u.update.partyABalance);
  assert.deepEqual(bytes(back.update.stateHash), bytes(u.update.stateHash));
  assert.deepEqual(bytes(back.sigA), bytes(u.sigA));
  assert.deepEqual(bytes(back.sigB), bytes(u.sigB));
});

test("writes are coalesced; flush forces one setItem; read round-trips; index + TTL", () => {
  const ls = (globalThis as Record<string, unknown>)
    .localStorage as FakeStorage;
  let sets = 0;
  const realSet = ls.setItem.bind(ls);
  ls.setItem = (k: string, v: string) => {
    sets++;
    realSet(k, v);
  };

  const rec = (tunnelId: string, updatedAt: number) => ({
    matchId: "m",
    tunnelId,
    role: "A" as const,
    game: "ttt",
    opponentWallet: "0xb",
    opponentPubkeyHex: "ab",
    latestCoSigned: toWireCoSigned(sampleCoSigned(tunnelId)),
    latestState: { board: [0], balanceA: 1000n, balanceB: 1000n },
    updatedAt,
  });
  writeResumeRecord(rec("0xT1", 100));
  writeResumeRecord(rec("0xT1", 200)); // same tunnel, coalesced
  const before = sets;
  flushResumeWrites();
  assert.ok(sets > before, "flush performed the deferred write");

  const got = readResumeRecord("0xT1");
  assert.equal(
    got?.latestState && (got.latestState as { balanceA: bigint }).balanceA,
    1000n,
  );
  assert.deepEqual(listActiveTunnels(), ["0xT1"]);

  writeResumeRecord(rec("0xT2", 1));
  flushResumeWrites();
  evictExpiredRecords(0); // everything is "older than 0ms"
  assert.equal(readResumeRecord("0xT1"), null);
  assert.deepEqual(listActiveTunnels(), []);

  clearResumeRecord("0xT2");
});

test("hasResumableMatch is true only when a record for that game is persisted", () => {
  const tA = `0x${"a1".repeat(32)}`;
  const tB = `0x${"b2".repeat(32)}`;
  const mk = (tunnelId: string, game: string) => ({
    matchId: "m",
    tunnelId,
    role: "A" as const,
    game,
    opponentWallet: "0xb",
    opponentPubkeyHex: "ab",
    selfEphemeralSecretHex: toHex(generateKeyPair().secretKey),
    latestCoSigned: toWireCoSigned(sampleCoSigned(tunnelId)),
    latestState: { board: [0] },
    updatedAt: 1,
  });

  assert.equal(hasResumableMatch("quantum-poker"), false, "no records yet");

  writeResumeRecord(mk(tA, "ttt"));
  flushResumeWrites();
  assert.equal(
    hasResumableMatch("quantum-poker"),
    false,
    "only an unrelated game is persisted",
  );

  writeResumeRecord(mk(tB, "quantum-poker"));
  flushResumeWrites();
  assert.equal(
    hasResumableMatch("quantum-poker"),
    true,
    "a quantum-poker record is now persisted",
  );

  clearResumeRecord(tB);
  assert.equal(
    hasResumableMatch("quantum-poker"),
    false,
    "cleared the only quantum-poker record",
  );
  clearResumeRecord(tA);
});

// --- tiny fixtures local to the test ---
function counterProto() {
  return {
    name: "counter-test",
    initialState: () => ({ count: 0, turn: "A" as const }),
    applyMove: (s: { count: number; turn: "A" | "B" }) => ({
      count: s.count + 1,
      turn: s.turn === "A" ? ("B" as const) : ("A" as const),
    }),
    encodeState: (s: { count: number }) => new Uint8Array([s.count & 0xff]),
    balances: () => ({ a: 1000n, b: 1000n }),
    isTerminal: () => false,
  };
}
function sampleCoSigned(_tunnelId: string) {
  const ka = generateKeyPair(),
    kb = generateKeyPair();
  // The signed update needs a valid 32-byte hex tunnelId; the resume-record key (_tunnelId)
  // is independent of the co-signed update's own id for this persistence test.
  const tid = `0x${"31".repeat(32)}`;
  const sp = OffchainTunnel.selfPlay(
    counterProto(),
    tid,
    ka,
    kb,
    "0xA",
    "0xB",
    { a: 1000n, b: 1000n },
  );
  sp.step(1, "A");
  return sp.latest!;
}
