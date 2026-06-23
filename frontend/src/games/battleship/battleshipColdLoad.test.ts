import test from "node:test";
import assert from "node:assert/strict";
import { makeBattleshipResumeAdapter } from "./battleshipResumeAdapter";
import { makeFleetSecret, randomFleetSecret } from "./engine/selfPlay";
import { placementsToBoard, type Placement } from "./engine/fleet";
import { randomSalts } from "./engine/merkle";
import { proposeDue } from "./engine/pvpDriver";
import { BattleshipProtocol, battleshipMoveCodec } from "./protocol/battleship";
import { rebuildTunnel, restoreInto } from "@/pvp/resumeSession";
import {
  writeResumeRecord,
  flushResumeWrites,
  readResumeRecord,
  clearResumeRecord,
  toWireCoSigned,
} from "@/pvp/resume";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { makeEndpoint, OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { toHex } from "sui-tunnel-ts/core/bytes";

// localStorage/window fakes for the cold-load round-trip below. Resume modules touch storage
// lazily (inside the test body), so static imports are safe.
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

// Deterministic rng so the fleets (and thus the reveal proof) are reproducible.
function mkRng(seed0: number): () => number {
  let seed = seed0;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bsAdapter(store: { secret: unknown; placements: Placement[] }) {
  return makeBattleshipResumeAdapter({
    getSecret: () => store.secret as never,
    setSecret: (s) => {
      store.secret = s;
    },
    getPlacements: () => store.placements,
    setPlacements: (p) => {
      store.placements = p;
    },
  });
}

// deriveBattleshipView/fleetStatus need Placement[] for per-ship damage, and placements are NOT
// reconstructable from the 0/1 board — so the resume secret must carry both the fleet AND the
// placements, captured/restored through the hidden-secret channel (never via serializeState).
test("battleship secret blob round-trips fleet + placements; serializeState excludes both", () => {
  const placements = [{ id: "carrier", cell: 0, orient: "H" as const }];
  const fleet = makeFleetSecret(placementsToBoard(placements), randomSalts());
  let store: { fleet: unknown; placements: unknown } = { fleet, placements };
  const adapter = makeBattleshipResumeAdapter({
    getSecret: () => store.fleet as never,
    getPlacements: () => store.placements as never,
    setSecret: (s) => {
      store.fleet = s;
    },
    setPlacements: (p) => {
      store.placements = p;
    },
  });
  const captured = adapter.captureSecret!();
  store = { fleet: null, placements: null };
  adapter.restoreSecret!(captured);
  assert.ok(store.fleet);
  assert.deepEqual(store.placements, placements);
  const pub = adapter.serializeState({
    commitA: null,
    commitB: null,
  } as never) as Record<string, unknown>;
  assert.equal(pub.salts, undefined);
  assert.equal(pub.placements, undefined);
});

// End-to-end cold-load: a reloaded defender rebuilds its tunnel from localStorage and reveals the
// next move byte-identically to a tunnel restored from the in-memory record. The reference uses the
// pre-JSON secret while the rebuilt seat uses the localStorage round-trip, so a non-JSON-safe secret
// (raw Uint8Array board/salts) would corrupt only the rebuilt reveal and break parity.
test("battleship cold-load: rebuilt defender reveals the next move byte-identically", () => {
  const proto = new BattleshipProtocol(100n) as never;
  const secretA = randomFleetSecret(mkRng(0x1111));
  const secretB = randomFleetSecret(mkRng(0x2222));
  const ka = generateKeyPair(),
    kb = generateKeyPair();
  const tid = `0x${"72".repeat(32)}`;

  // A commits, B commits, A shoots cell 0 → seat B now owes a reveal (needs board + salts).
  const sp = OffchainTunnel.selfPlay(
    proto,
    tid,
    ka as never,
    kb as never,
    "0xA",
    "0xB",
    { a: 500n, b: 500n },
  );
  sp.step({ type: "commit", root: secretA.commitment.root }, "A");
  sp.step({ type: "commit", root: secretB.commitment.root }, "B");
  sp.step({ type: "shoot", cell: 0 }, "A");

  // Persist seat B's record; the secret is captured JSON-safe via the adapter.
  const capStore = {
    secret: secretB as unknown,
    placements: [] as Placement[],
  };
  const capAdapter = bsAdapter(capStore);
  const record = {
    matchId: "match-bs",
    tunnelId: tid,
    role: "B" as const,
    game: "battleship",
    opponentWallet: "0xA",
    opponentPubkeyHex: toHex(ka.publicKey),
    selfEphemeralSecretHex: toHex(kb.secretKey),
    latestCoSigned: toWireCoSigned(sp.latest!),
    latestState: capAdapter.serializeState(sp.state as never),
    secret: capAdapter.captureSecret!(),
    updatedAt: Date.now(),
  };
  writeResumeRecord(record);
  flushResumeWrites();

  // Reference: restored from the IN-MEMORY record (pre-JSON), proposing B's reveal.
  const backend = defaultBackend();
  const refSent: Uint8Array[] = [];
  const refStore = { secret: null as unknown, placements: [] as Placement[] };
  const ref = new DistributedTunnel(
    proto,
    {
      tunnelId: tid,
      self: makeEndpoint(
        backend,
        "0xB",
        { publicKey: kb.publicKey, scheme: 0, secretKey: kb.secretKey },
        true,
      ),
      opponent: makeEndpoint(
        backend,
        "0xA",
        { publicKey: ka.publicKey, scheme: 0 },
        false,
      ),
      selfParty: "B",
      moveCodec: battleshipMoveCodec,
    },
    { send: (b) => refSent.push(b), onFrame() {} },
    { a: 500n, b: 500n },
  );
  restoreInto(ref as never, record as never, bsAdapter(refStore) as never);
  proposeDue(ref as never, "B", refStore.secret as never);

  // Rebuilt: restored from the localStorage round-trip alone.
  const sent: Uint8Array[] = [];
  const rebuiltStore = {
    secret: null as unknown,
    placements: [] as Placement[],
  };
  const mp = {
    channel: () => ({
      transport: { send: (b: Uint8Array) => sent.push(b), onFrame() {} },
      sendPeer() {},
      onPeer() {},
      addPeerListener() {},
      removePeerListener() {},
    }),
    markActive() {},
  } as never;
  const { tunnel } = rebuildTunnel(
    mp,
    readResumeRecord(tid)!,
    {
      proto,
      moveCodec: battleshipMoveCodec,
      adapter: bsAdapter(rebuiltStore),
    } as never,
    { selfWallet: "0xB" },
  );
  proposeDue(tunnel as never, "B", rebuiltStore.secret as never);

  assert.ok(refSent.length > 0, "reference defender produced a reveal");
  assert.deepEqual(
    Uint8Array.from(sent[0]),
    Uint8Array.from(refSent[0]),
    "rebuilt defender reveals byte-identically to the in-memory reference",
  );
  clearResumeRecord(tid);
});
