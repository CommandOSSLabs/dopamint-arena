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
const { restoreInto, rebuildTunnel, resumeActiveTunnels, buildRecord } =
  await import("./resumeSession");
const {
  writeResumeRecord,
  flushResumeWrites,
  readResumeRecord,
  clearResumeRecord,
  toWireCoSigned,
} = await import("./resume");
const { DistributedTunnel } =
  await import("sui-tunnel-ts/core/distributedTunnel");
const { makeEndpoint, OffchainTunnel } =
  await import("sui-tunnel-ts/core/tunnel");
const { defaultBackend } = await import("sui-tunnel-ts/core/crypto-native");
const { generateKeyPair } = await import("sui-tunnel-ts/core/crypto");
const { toHex } = await import("sui-tunnel-ts/core/bytes");

// A fake MpClient whose channel captures the engine-transport bytes a rebuilt tunnel sends.
function makeFakeMp() {
  const sent: Uint8Array[] = [];
  const active: string[] = [];
  return {
    sent,
    active,
    channel: () => ({
      transport: { send: (b: Uint8Array) => sent.push(b), onFrame() {} },
      sendPeer() {},
      onPeer() {},
      addPeerListener() {},
      removePeerListener() {},
    }),
    markActive: (id: string) => active.push(id),
    onResumeOk: () => () => {},
    onPeerResumed: () => () => {},
    onPeerDropped: () => () => {},
  };
}

// Drive self-play to nonce 2 and return a persistable record for seat A.
function recordAtNonce2(tid: string, ka: never, kb: never, game = "counter") {
  const sp = OffchainTunnel.selfPlay(
    proto as never,
    tid,
    ka,
    kb,
    "0xA",
    "0xB",
    {
      a: 1000n,
      b: 1000n,
    },
  );
  sp.step(0, "A");
  sp.step(0, "B");
  return {
    matchId: `match-${tid.slice(0, 6)}`,
    tunnelId: tid,
    role: "A" as const,
    game,
    opponentWallet: "0xB",
    opponentPubkeyHex: toHex((kb as { publicKey: Uint8Array }).publicKey),
    selfEphemeralSecretHex: toHex((ka as { secretKey: Uint8Array }).secretKey),
    latestCoSigned: toWireCoSigned(sp.latest!),
    latestState: adapter.serializeState(sp.state),
    updatedAt: Date.now(),
  };
}

test("rebuildTunnel reconstructs a tunnel that co-signs the next move byte-identically", () => {
  const ka = generateKeyPair(),
    kb = generateKeyPair();
  const tid = `0x${"43".repeat(32)}`;
  const record = recordAtNonce2(tid, ka as never, kb as never);
  writeResumeRecord(record);
  flushResumeWrites();

  // Reference: a never-dropped tunnel restored from the same checkpoint, proposing move 0 @ ts 9.
  const backend = defaultBackend();
  const refSent: Uint8Array[] = [];
  const ref = new DistributedTunnel(
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
    { send: (b) => refSent.push(b), onFrame() {} },
    { a: 1000n, b: 1000n },
  );
  restoreInto(ref, readResumeRecord(tid)!, adapter as never);
  ref.propose(0, 9n);

  // Rebuilt from the persisted record alone (fresh objects, same persisted secret).
  const mp = makeFakeMp();
  const spec = { proto, adapter };
  const session = rebuildTunnel(
    mp as never,
    readResumeRecord(tid)!,
    spec as never,
    { selfWallet: "0xA" },
  );
  assert.equal(session.tunnel.nonce, 2n);
  assert.deepEqual(mp.active, [record.matchId]);
  assert.equal((session as { detach?: unknown }).detach, undefined);
  assert.equal(session.tunnel.onConfirmed, undefined);
  session.tunnel.propose(0, 9n);
  assert.equal(mp.sent.length, 1);
  assert.deepEqual(
    Uint8Array.from(mp.sent[0]),
    Uint8Array.from(refSent[0]),
    "rebuilt tunnel proposes byte-identically to a never-dropped tunnel",
  );
  clearResumeRecord(tid);
});

test("resumeActiveTunnels evicts expired records and rebuilds only the given game", () => {
  const tidLive = `0x${"44".repeat(32)}`;
  const tidExpired = `0x${"45".repeat(32)}`;
  const tidOther = `0x${"46".repeat(32)}`;
  const live = recordAtNonce2(
    tidLive,
    generateKeyPair() as never,
    generateKeyPair() as never,
  );
  writeResumeRecord(live);
  writeResumeRecord({
    ...recordAtNonce2(
      tidExpired,
      generateKeyPair() as never,
      generateKeyPair() as never,
    ),
    updatedAt: 0, // older than any TTL → evicted before rebuild
  });
  writeResumeRecord(
    recordAtNonce2(
      tidOther,
      generateKeyPair() as never,
      generateKeyPair() as never,
      "other-game",
    ),
  );
  flushResumeWrites();

  const mp = makeFakeMp();
  const sessions = resumeActiveTunnels(
    mp as never,
    "counter",
    { proto, adapter } as never,
    {
      selfWallet: "0xA",
    },
  );

  assert.equal(sessions.length, 1, "only the live counter record is rebuilt");
  assert.equal(sessions[0].tunnel.nonce, 2n);
  assert.equal(readResumeRecord(tidExpired), null, "expired record evicted");
  assert.ok(readResumeRecord(tidOther), "other-game record left untouched");

  clearResumeRecord(tidLive);
  clearResumeRecord(tidOther);
});

test("resumeActiveTunnels drops a terminal record instead of rebuilding a finished match", () => {
  const tidTerminal = `0x${"47".repeat(32)}`;
  writeResumeRecord(
    recordAtNonce2(
      tidTerminal,
      generateKeyPair() as never,
      generateKeyPair() as never,
    ),
  );
  flushResumeWrites();

  // Same fixtures, but this game reports its restored state as terminal (match over).
  // A finished match must NOT rebuild into a live "playing" tunnel — that is what strands
  // the settled board on refresh and blocks the arena from allocating a new game.
  const terminalProto = { ...proto, isTerminal: () => true };
  const mp = makeFakeMp();
  const sessions = resumeActiveTunnels(
    mp as never,
    "counter",
    { proto: terminalProto, adapter } as never,
    { selfWallet: "0xA" },
  );

  assert.equal(
    sessions.length,
    0,
    "a finished match is not rebuilt into a live tunnel",
  );
  assert.equal(
    readResumeRecord(tidTerminal),
    null,
    "the terminal record is cleared so the arena can allocate a new game",
  );
  assert.deepEqual(
    mp.active,
    [],
    "no tunnel is marked active for a finished match",
  );
});

test("buildRecord stamps terminal from the tunnel protocol (proto-less readers can trust it)", () => {
  const ka = generateKeyPair(),
    kb = generateKeyPair();
  const tid = `0x${"48".repeat(32)}`;
  const sp = OffchainTunnel.selfPlay(
    proto as never,
    tid,
    ka,
    kb,
    "0xA",
    "0xB",
    {
      a: 1000n,
      b: 1000n,
    },
  );
  sp.step(0, "A");
  sp.step(0, "B");
  const identity = {
    matchId: "m",
    tunnelId: tid,
    role: "A" as const,
    game: "counter",
    opponentWallet: "0xB",
    opponentPubkeyHex: "ab",
    selfEphemeralSecretHex: "cd",
  };
  const snap = { latest: sp.latest, state: sp.state, pending: null };

  // Same snapshot, two protocols: the record must mark terminal iff the game reports game-over.
  const finished = buildRecord(
    { protocol: { isTerminal: () => true }, snapshot: () => snap } as never,
    adapter as never,
    identity,
  );
  const inFlight = buildRecord(
    { protocol: { isTerminal: () => false }, snapshot: () => snap } as never,
    adapter as never,
    identity,
  );
  assert.equal(
    finished?.terminal,
    true,
    "finished match → record marked terminal",
  );
  assert.equal(
    inFlight?.terminal,
    false,
    "in-flight match → record not terminal",
  );
});

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
    resendPending: () => {},
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

// On resume, attachResume must BOTH announce the resync AND re-send any restored pending — the latter
// is what the custom hooks (poker, tic-tac-toe/caro, battleship, blackjack) never did themselves, so a
// move made just before a reload deadlocked the bot. Doing it in the shared handler covers every hook.
test("resume.ok re-sends the pending and the resync (covers custom hooks)", async () => {
  const { attachResume } = await import("./resumeSession");
  const okSubs: ((e: { matchId: string }) => void)[] = [];
  const fakeMp = {
    onPeerDropped: () => () => {},
    onResumeOk: (cb: never) => {
      okSubs.push(cb as never);
      return () => {};
    },
    onPeerResumed: () => () => {},
  };
  let sentPeer = 0;
  let resent = 0;
  const channel = {
    addPeerListener() {},
    removePeerListener() {},
    sendPeer() {
      sentPeer++;
    },
    transport: { send() {}, onFrame() {} },
    onPeer() {},
  };
  const tunnel = {
    snapshot: () => ({ state: {}, nonce: 3n, latest: null, pending: null }),
    resendPending: () => {
      resent++;
    },
    onConfirmed: undefined,
  } as never;
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
  } as never);

  okSubs.forEach((cb) => cb({ matchId: "m1" }));
  assert.equal(sentPeer, 1, "resync announced on resume");
  assert.equal(
    resent,
    1,
    "restored pending re-sent on resume (the custom-hook fix)",
  );

  // A resume for a different match must not touch this session.
  okSubs.forEach((cb) => cb({ matchId: "other" }));
  assert.equal(resent, 1, "only this match's resume re-sends");
});
