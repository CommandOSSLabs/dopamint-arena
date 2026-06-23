import test from "node:test";
import assert from "node:assert/strict";
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
import { MultiGameTicTacToeProtocol } from "@ttt/shared";
import { makeTttResumeAdapter } from "./app/lib/tttResumeAdapter";

// localStorage/window fakes. The resume modules touch storage lazily (only inside the calls
// below, which run within the test), so static imports are safe; this dir is CJS (its
// package.json has no "type"), which rules out the top-level-await dynamic-import pattern.
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

// A reloaded ttt seat must rebuild its tunnel from the persisted record alone and co-sign the
// next move byte-for-byte identically to a tunnel that was never dropped — proving the cold-load
// path (queue → resumeActiveTunnels → activateTttSession) reconstructs an equivalent signer.
test("ttt cold-load: rebuilt tunnel co-signs the next move byte-identically", () => {
  const proto = new MultiGameTicTacToeProtocol(1000, 1n) as never;
  const adapter = makeTttResumeAdapter(() => {});
  const ka = generateKeyPair(),
    kb = generateKeyPair();
  const tid = `0x${"71".repeat(32)}`;

  // Drive a self-play tunnel to nonce 2 (X plays cell 0, O plays cell 1) and persist seat A's record.
  const sp = OffchainTunnel.selfPlay(
    proto,
    tid,
    ka as never,
    kb as never,
    "0xA",
    "0xB",
    { a: 1000n, b: 1000n },
  );
  sp.step({ cell: 0 }, "A");
  sp.step({ cell: 1 }, "B");
  const record = {
    matchId: "match-ttt",
    tunnelId: tid,
    role: "A" as const,
    game: "ttt",
    opponentWallet: "0xB",
    opponentPubkeyHex: toHex(kb.publicKey),
    selfEphemeralSecretHex: toHex(ka.secretKey),
    latestCoSigned: toWireCoSigned(sp.latest!),
    latestState: adapter.serializeState(sp.state as never),
    updatedAt: Date.now(),
  };
  writeResumeRecord(record);
  flushResumeWrites();

  // Reference: a never-dropped tunnel restored from the same checkpoint, proposing { cell: 2 } @ ts 9.
  const backend = defaultBackend();
  const refSent: Uint8Array[] = [];
  const ref = new DistributedTunnel(
    proto,
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
  restoreInto(ref as never, readResumeRecord(tid)!, adapter as never);
  (ref as never as { propose(m: unknown, ts: bigint): void }).propose(
    { cell: 2 },
    9n,
  );

  // Rebuilt from the persisted record alone (fresh objects, same persisted signing key).
  const sent: Uint8Array[] = [];
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
    { proto, adapter } as never,
    { selfWallet: "0xA" },
  );
  assert.equal(tunnel.nonce, 2n);
  (tunnel as never as { propose(m: unknown, ts: bigint): void }).propose(
    { cell: 2 },
    9n,
  );
  assert.deepEqual(
    Uint8Array.from(sent[0]),
    Uint8Array.from(refSent[0]),
    "rebuilt ttt tunnel proposes byte-identically to a never-dropped tunnel",
  );
  clearResumeRecord(tid);
});
