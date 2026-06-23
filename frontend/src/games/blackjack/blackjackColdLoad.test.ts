import test from "node:test";
import assert from "node:assert/strict";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { makeEndpoint, OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { rebuildTunnel, restoreInto } from "@/pvp/resumeSession";
import {
  writeResumeRecord,
  flushResumeWrites,
  readResumeRecord,
  clearResumeRecord,
  toWireCoSigned,
} from "@/pvp/resume";
import {
  BlackjackBetProtocol,
  actorFor,
  fixedBetMove,
  type BetBlackjackState,
  type BetBlackjackMove,
} from "./app/lib/bjBetProtocol";
import { makeBlackjackResumeAdapter } from "./blackjackResumeAdapter";

// localStorage/window fakes (resume modules touch storage lazily, inside the test body).
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

type Proto = BlackjackBetProtocol;
const nextMove = (
  proto: Proto,
  s: BetBlackjackState,
): BetBlackjackMove | null =>
  s.phase === "round_over"
    ? fixedBetMove(50, s)
    : proto.randomMove(s as never, actorFor(s), () => 0);

// A reloaded blackjack seat must rebuild from localStorage with the SAME asymmetric per-seat
// buy-ins (recovered from the checkpoint split, not a separate stake message) and co-sign its next
// move byte-identically to a never-dropped tunnel.
test("blackjack cold-load: rebuilt seat keeps asymmetric balances and co-signs byte-identically", () => {
  const proto = new BlackjackBetProtocol() as never;
  const ka = generateKeyPair(),
    kb = generateKeyPair();
  const tid = `0x${"74".repeat(32)}`;
  const adapter = makeBlackjackResumeAdapter(() => {});

  // Drive a self-play tunnel with ASYMMETRIC buy-ins until seat A (the player) owes the next move.
  const sp = OffchainTunnel.selfPlay(
    proto,
    tid,
    ka as never,
    kb as never,
    "0xA",
    "0xB",
    { a: 300n, b: 700n },
  );
  let guard = 0;
  while (!(sp.latest && actorFor(sp.state) === "A") && guard++ < 30) {
    const by = actorFor(sp.state);
    const move = nextMove(proto, sp.state);
    if (!move) break;
    sp.step(move, by);
  }
  assert.ok(
    sp.latest && actorFor(sp.state) === "A",
    "drove blackjack to a checkpoint where seat A acts next",
  );
  // Asymmetric split survived into the checkpoint (the two seats funded 300/700).
  assert.notEqual(
    sp.latest!.update.partyABalance,
    sp.latest!.update.partyBBalance,
  );

  const move = nextMove(proto, sp.state)!;
  const MOVE_TS = 9n;

  const record = {
    matchId: "match-bj",
    tunnelId: tid,
    role: "A" as const,
    game: "blackjack",
    opponentWallet: "0xB",
    opponentPubkeyHex: toHex(kb.publicKey),
    selfEphemeralSecretHex: toHex(ka.secretKey),
    latestCoSigned: toWireCoSigned(sp.latest!),
    latestState: adapter.serializeState(sp.state),
    updatedAt: Date.now(),
  };
  writeResumeRecord(record);
  flushResumeWrites();

  // Reference: a never-dropped tunnel restored from the same checkpoint, with the asymmetric split.
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
    { a: 300n, b: 700n },
  );
  restoreInto(ref as never, readResumeRecord(tid)!, adapter as never);
  (ref as never as { propose(m: BetBlackjackMove, ts: bigint): void }).propose(
    move,
    MOVE_TS,
  );

  // Rebuilt: from the persisted record alone. balancesFromCheckpoint recovers the 300/700 split.
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
  assert.equal(
    tunnel.latest!.update.partyABalance,
    sp.latest!.update.partyABalance,
  );
  assert.equal(
    tunnel.latest!.update.partyBBalance,
    sp.latest!.update.partyBBalance,
  );
  (
    tunnel as never as { propose(m: BetBlackjackMove, ts: bigint): void }
  ).propose(move, MOVE_TS);

  assert.deepEqual(
    Uint8Array.from(sent[0]),
    Uint8Array.from(refSent[0]),
    "rebuilt blackjack seat proposes byte-identically to a never-dropped tunnel",
  );
  clearResumeRecord(tid);
});
