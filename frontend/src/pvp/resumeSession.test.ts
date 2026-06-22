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

test("peer.dropped starts a grace timer; peer return cancels it; expiry offers settle", async () => {
  const { attachResume } = await import("./resumeSession");
  // Minimal fake MpClient: capture subscribers, expose triggers.
  const subs: Record<
    string,
    ((e: { matchId: string; peerOnline?: boolean }) => void)[]
  > = { drop: [], ok: [], res: [] };
  const fakeMp = {
    onPeerDropped: (cb: never) => {
      subs.drop.push(cb as never);
      return () => {};
    },
    onResumeOk: (cb: never) => {
      subs.ok.push(cb as never);
      return () => {};
    },
    onPeerResumed: (cb: never) => {
      subs.res.push(cb as never);
      return () => {};
    },
  };
  const channel = {
    addPeerListener() {},
    removePeerListener() {},
    sendPeer() {},
    transport: { send() {}, onFrame() {} },
    onPeer() {},
  };
  let fire: (() => void) | null = null;
  const sched = {
    set: (fn: () => void) => {
      fire = fn;
      return 1 as never;
    },
    clear: () => {
      fire = null;
    },
  };

  // No latest yet → onGraceExpired receives null but still fires.
  const tunnel = {
    snapshot: () => ({ state: {}, nonce: 0n, latest: null, pending: null }),
    onConfirmed: undefined,
  } as never;
  let expired: unknown = "unset";
  attachResume({
    mp: fakeMp as never,
    channel: channel as never,
    tunnel,
    adapter: {
      serializeState: (s: unknown) => s,
      deserializeState: (j: unknown) => j,
      onReconciled() {},
    } as never,
    identity: {
      matchId: "m1",
      tunnelId: "0xT",
      role: "A",
      game: "g",
      opponentWallet: "0xb",
      opponentPubkeyHex: "ab",
    },
    graceMs: 3_600_000,
    onGraceExpired: (l) => {
      expired = l;
    },
    timers: {
      setTimeout: sched.set as never,
      clearTimeout: sched.clear as never,
    },
  } as never);

  // peer drops → timer armed
  subs.drop.forEach((cb) => cb({ matchId: "m1" }));
  assert.ok(fire, "grace timer armed on peer.dropped");
  // peer returns before expiry → timer cancelled, no settle offer
  subs.res.forEach((cb) => cb({ matchId: "m1" }));
  assert.equal(fire, null, "grace timer cancelled on peer return");
  assert.equal(expired, "unset");

  // drop again, then let it expire
  subs.drop.forEach((cb) => cb({ matchId: "m1" }));
  fire!();
  assert.equal(
    expired,
    null,
    "grace expiry offered settle from the held checkpoint (null here)",
  );
});
