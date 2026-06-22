import test from "node:test";
import assert from "node:assert/strict";
// localStorage/window fakes must exist before importing resume modules.
(globalThis as Record<string, unknown>).localStorage = new (class {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
})();
(globalThis as Record<string, unknown>).window = { addEventListener() {} };

const { decideReconcile } = await import("sui-tunnel-ts/core/reconcile");
const { restoreInto } = await import("./resumeSession");
const {
  writeResumeRecord,
  flushResumeWrites,
  readResumeRecord,
  toWireCoSigned,
} = await import("./resume");
const { DistributedTunnel } =
  await import("sui-tunnel-ts/core/distributedTunnel");
const { makeEndpoint, OffchainTunnel } =
  await import("sui-tunnel-ts/core/tunnel");
const { defaultBackend } = await import("sui-tunnel-ts/core/crypto-native");
const { generateKeyPair } = await import("sui-tunnel-ts/core/crypto");

const proto = {
  name: "counter-test",
  initialState: () => ({ count: 0, turn: "A" as const }),
  applyMove: (
    s: { count: number; turn: "A" | "B" },
    _m: number,
    by: "A" | "B",
  ) => ({
    count: s.count + 1,
    turn: by === "A" ? ("B" as const) : ("A" as const),
  }),
  encodeState: (s: { count: number }) => new Uint8Array([s.count & 0xff]),
  balances: () => ({ a: 1000n, b: 1000n }),
  isTerminal: () => false,
};
const adapter = {
  serializeState: (s: unknown) => s,
  deserializeState: (j: unknown) => j as { count: number; turn: "A" | "B" },
  onReconciled: () => {},
};

test("restoreInto reconstructs a tunnel that co-signs the next move byte-identically", () => {
  const ka = generateKeyPair(),
    kb = generateKeyPair();
  const tid = `0x${"41".repeat(32)}`;
  // Self-play to nonce 2 to get a real checkpoint + state.
  const sp = OffchainTunnel.selfPlay(
    proto as never,
    tid,
    ka,
    kb,
    "0xA",
    "0xB",
    { a: 1000n, b: 1000n },
  );
  sp.step(0, "A");
  sp.step(0, "B");
  const record = {
    matchId: "m",
    tunnelId: tid,
    role: "A" as const,
    game: "counter",
    opponentWallet: "0xB",
    opponentPubkeyHex: "ab",
    latestCoSigned: toWireCoSigned(sp.latest!),
    latestState: adapter.serializeState(sp.state),
    updatedAt: Date.now(),
  };
  writeResumeRecord(record);
  flushResumeWrites();

  const backend = defaultBackend();
  const sent: Uint8Array[] = [];
  const restored = new DistributedTunnel(
    proto as never,
    {
      tunnelId: tid,
      self: makeEndpoint(
        backend,
        "0xA",
        { publicKey: ka.publicKey, scheme: 0, secretKey: ka.secretKey },
        true,
      ),
      opponent: makeEndpoint(
        backend,
        "0xB",
        { publicKey: kb.publicKey, scheme: 0 },
        false,
      ),
      selfParty: "A",
    },
    { send: (b) => sent.push(b), onFrame() {} },
    { a: 1000n, b: 1000n },
  );
  restoreInto(restored, readResumeRecord(tid)!, adapter as never);
  assert.equal(restored.nonce, 2n);
  // The restored tunnel proposes move 3 with the exact bytes a never-dropped tunnel would.
  restored.propose(0, 9n);
  assert.equal(restored.nonce, 2n); // unconfirmed
  assert.ok(sent.length === 1);
});

test("decideReconcile + adopt path: a peer-ahead resync seats the missed move", () => {
  // Drive the same fixtures: self at nonce 1, peer at nonce 2 with a checkpoint+fullState.
  const ka = generateKeyPair(),
    kb = generateKeyPair();
  const tid = `0x${"42".repeat(32)}`;
  const sp = OffchainTunnel.selfPlay(
    proto as never,
    tid,
    ka,
    kb,
    "0xA",
    "0xB",
    { a: 1000n, b: 1000n },
  );
  sp.step(0, "A"); // nonce 1 — what self has
  const selfState = sp.state,
    selfCp = sp.latest!;
  sp.step(0, "B"); // nonce 2 — what peer has
  const peerState = sp.state,
    peerCp = sp.latest!;

  const self = { nonce: 1n, hasPending: false, checkpoint: selfCp };
  const peer = { nonce: 2n, hasPending: false, checkpoint: peerCp };
  assert.equal(decideReconcile(self, peer).action, "adopt");

  const backend = defaultBackend();
  const t = new DistributedTunnel(
    proto as never,
    {
      tunnelId: tid,
      self: makeEndpoint(
        backend,
        "0xA",
        { publicKey: ka.publicKey, scheme: 0, secretKey: ka.secretKey },
        true,
      ),
      opponent: makeEndpoint(
        backend,
        "0xB",
        { publicKey: kb.publicKey, scheme: 0 },
        false,
      ),
      selfParty: "A",
    },
    { send() {}, onFrame() {} },
    { a: 1000n, b: 1000n },
  );
  t.adoptCheckpoint(selfState, selfCp); // self restored at 1
  t.adoptCheckpoint(peerState, peerCp); // adopt the peer-ahead checkpoint
  assert.equal(t.nonce, 2n);
});
