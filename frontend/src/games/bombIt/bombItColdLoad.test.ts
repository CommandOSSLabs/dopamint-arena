import test from "node:test";
import assert from "node:assert/strict";
import { makeBombItResumeAdapter } from "./bombItResumeAdapter.ts";
import { rebuildTunnel } from "../../pvp/resumeSession.ts";
import {
  writeResumeRecord, flushResumeWrites, readResumeRecord, clearResumeRecord, toWireCoSigned,
} from "../../pvp/resume.ts";
import { OffchainTunnel } from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { generateKeyPair } from "../../../../sui-tunnel-ts/src/core/crypto.ts";
import { toHex } from "../../../../sui-tunnel-ts/src/core/bytes.ts";
import { BombItProtocol } from "../../../../sui-tunnel-ts/src/protocol/bombIt.ts";

(globalThis as Record<string, unknown>).localStorage = new (class {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
})();
(globalThis as Record<string, unknown>).window = { addEventListener() {} };

test("bomb-it cold-load: rebuilt tunnel restores the co-signed state from localStorage", () => {
  const proto = new BombItProtocol() as never;
  const ka = generateKeyPair(), kb = generateKeyPair();
  const tid = `0x${"b1".repeat(32)}`;
  const sp = OffchainTunnel.selfPlay(proto, tid, ka as never, kb as never, "0xA", "0xB", { a: 500n, b: 500n });
  sp.step({ a: "bomb" }, "A");
  sp.step({ b: "north" }, "B");

  const adapter = makeBombItResumeAdapter();
  writeResumeRecord({
    matchId: "match-bomb-it", tunnelId: tid, role: "B", game: "bomb-it",
    opponentWallet: "0xA", opponentPubkeyHex: toHex(ka.publicKey),
    selfEphemeralSecretHex: toHex(kb.secretKey),
    latestCoSigned: toWireCoSigned(sp.latest!),
    latestState: adapter.serializeState(sp.state as never),
    updatedAt: Date.now(),
  } as never);
  flushResumeWrites();

  const mp = { channel: () => ({ transport: { send() {}, onFrame() {} }, sendPeer() {}, onPeer() {}, addPeerListener() {}, removePeerListener() {} }), markActive() {} } as never;
  const { tunnel } = rebuildTunnel(mp, readResumeRecord(tid)!, { proto, adapter: makeBombItResumeAdapter() } as never, { selfWallet: "0xB" });
  const st = (tunnel as { snapshot(): { state: { tick: bigint; balanceA: bigint; total: bigint; grid: Uint8Array } } }).snapshot().state;
  assert.equal(st.tick, sp.state.tick);
  assert.equal(st.balanceA, sp.state.balanceA);
  assert.equal(st.balanceB, sp.state.balanceB);
  assert.equal(st.total, sp.state.total);
  assert.deepEqual(Array.from(st.grid), Array.from(sp.state.grid));
  clearResumeRecord(tid);
});
