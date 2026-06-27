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
  BlackjackProtocol,
  actorFor,
  type BlackjackState,
  type BlackjackMove,
} from "sui-tunnel-ts/protocol/blackjack";
import { bjBetMove } from "@/games/blackjack/app/lib/bjBet";
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

// Drive one protocol move for the given actor; handles bet, commit, reveal, hit/stand phases.
function nextMove(
  proto: BlackjackProtocol,
  s: BlackjackState,
): BlackjackMove | null {
  if (s.phase === "round_over") return bjBetMove(50, s);
  const by = actorFor(s);
  if (!by) return null;
  return proto.randomMove(s, by, Math.random);
}

// A reloaded blackjack seat must rebuild from localStorage with the SAME asymmetric per-seat
// buy-ins (recovered from the checkpoint split, not a separate stake message) and co-sign its next
// move byte-identically to a never-dropped tunnel.
test("blackjack cold-load: rebuilt seat keeps asymmetric balances and co-signs byte-identically", () => {
  const proto = new BlackjackProtocol() as never;
  const ka = generateKeyPair(),
    kb = generateKeyPair();
  const tid = `0x${"74".repeat(32)}`;

  // Secrets live on the selfPlay tunnel state; the adapter reads/writes them there.
  let capturedSecretA: BlackjackState["localSecretA"] = null;
  let capturedSecretB: BlackjackState["localSecretB"] = null;
  const adapter = makeBlackjackResumeAdapter({
    getSecret: () => ({
      localSecretA: capturedSecretA,
      localSecretB: capturedSecretB,
    }),
    setSecret: (sec) => {
      capturedSecretA = sec.localSecretA;
      capturedSecretB = sec.localSecretB;
    },
    onReconciled: () => {},
  });

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
  // Advance until we are in a stable "player" phase where A acts — skipping the commit/reveal
  // ladder of the deal. Guard cap is generous because commit-reveal needs ~6–10 steps per round.
  while (guard++ < 200) {
    const by = actorFor(sp.state as never);
    if (by === "A" && (sp.state as never as BlackjackState).phase === "player")
      break;
    const move = nextMove(proto as never, sp.state as never);
    if (!move) break;
    sp.step(move, by ?? "A");
    // Mirror the active secret from tunnel state so the adapter can capture it.
    capturedSecretA = (sp.state as never as BlackjackState).localSecretA;
    capturedSecretB = (sp.state as never as BlackjackState).localSecretB;
  }
  const spState = sp.state as never as BlackjackState;
  assert.ok(
    sp.latest &&
      spState.phase === "player" &&
      actorFor(sp.state as never) === "A",
    "drove blackjack to a checkpoint where seat A plays next (player phase)",
  );
  // Asymmetric split survived into the checkpoint (the two seats funded 300/700).
  assert.notEqual(
    sp.latest!.update.partyABalance,
    sp.latest!.update.partyBBalance,
  );

  // Choose the move A will propose from this checkpoint.
  const move = nextMove(proto as never, sp.state as never)!;
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
    latestState: adapter.serializeState(sp.state as never),
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
  (ref as never as { propose(m: BlackjackMove, ts: bigint): void }).propose(
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
  (tunnel as never as { propose(m: BlackjackMove, ts: bigint): void }).propose(
    move,
    MOVE_TS,
  );

  assert.deepEqual(
    Uint8Array.from(sent[0]),
    Uint8Array.from(refSent[0]),
    "rebuilt blackjack seat proposes byte-identically to a never-dropped tunnel",
  );
  clearResumeRecord(tid);
});
