import {
  clearResumeRecord,
  flushResumeWrites,
  readResumeRecord,
  toWireCoSigned,
  writeResumeRecord,
} from "@/pvp/resume";
import { rebuildTunnel, restoreInto } from "@/pvp/resumeSession";
import assert from "node:assert/strict";
import test from "node:test";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { makeEndpoint, OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import {
  actorFor,
  BlackjackBetProtocol,
  commitMoveFromSecret,
  fixedBetMove,
  revealMoveFromSecret,
  type BetBlackjackMove,
  type BetBlackjackSecret,
  type BetBlackjackState,
} from "./app/lib/bjBetProtocol";
import { handValue } from "./app/lib/bjCards";
import { bjMoveCodec } from "./app/lib/bjMoveCodec";
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

// Deterministic per-seat secrets so the self-play drive is reproducible (this is NOT a fairness
// path — both seats are local and no pre-image is relayed). Real play uses the CSPRNG.
const DET_A: BetBlackjackSecret = {
  value: new Uint8Array(16).fill(1),
  salt: new Uint8Array(16).fill(2),
};
const DET_B: BetBlackjackSecret = {
  value: new Uint8Array(16).fill(3),
  salt: new Uint8Array(16).fill(4),
};
/** The seat that acts next: plumbing A-then-B for draws, else the protocol's single actor. */
const actingSeat = (s: BetBlackjackState): "A" | "B" => {
  if (s.phase === "draw_commit") return !s.pendingCommitA ? "A" : "B";
  if (s.phase === "draw_reveal") return !s.pendingRevealA ? "A" : "B";
  return actorFor(s);
};
const moveFor = (s: BetBlackjackState, by: "A" | "B"): BetBlackjackMove => {
  if (s.phase === "draw_commit")
    return commitMoveFromSecret(by === "A" ? DET_A : DET_B);
  if (s.phase === "draw_reveal")
    return revealMoveFromSecret(
      (by === "A" ? s.localSecretA : s.localSecretB)!,
    );
  if (s.phase === "round_over") return fixedBetMove(50, s)!;
  return { action: handValue(s.playerHand) < 17 ? "hit" : "stand" };
};

// A reloaded blackjack seat must rebuild from localStorage with the SAME asymmetric per-seat
// buy-ins (recovered from the checkpoint split, not a separate stake message) and co-sign its next
// move byte-identically to a never-dropped tunnel.
test("blackjack cold-load: rebuilt seat keeps asymmetric balances and co-signs byte-identically", () => {
  const proto = new BlackjackBetProtocol() as never;
  const ka = generateKeyPair(),
    kb = generateKeyPair();
  const tid = `0x${"74".repeat(32)}`;
  const adapter = makeBlackjackResumeAdapter({
    getSecret: () => ({ localSecretA: null, localSecretB: null }),
    setSecret: () => {},
    onReconciled: () => {},
  });

  // Drive a self-play tunnel with ASYMMETRIC buy-ins through the opening commit-reveal deal until
  // seat A (the player) owes a DETERMINISTIC hit/stand — so the proposed move is byte-identical
  // across the never-dropped and rebuilt tunnels (a commit's CSPRNG secret would not be).
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
  while (
    !(sp.latest && sp.state.phase === "player" && actorFor(sp.state) === "A") &&
    guard++ < 200
  ) {
    const by = actingSeat(sp.state);
    sp.step(moveFor(sp.state, by), by);
  }
  assert.ok(
    sp.latest && sp.state.phase === "player" && actorFor(sp.state) === "A",
    "drove blackjack to a player-phase checkpoint where seat A acts next",
  );
  // Asymmetric split survived into the checkpoint (the two seats funded 300/700).
  assert.notEqual(
    sp.latest!.update.partyABalance,
    sp.latest!.update.partyBBalance,
  );

  const move = moveFor(sp.state, "A");
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
      moveCodec: bjMoveCodec,
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
    { proto, adapter, moveCodec: bjMoveCodec } as never,
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
