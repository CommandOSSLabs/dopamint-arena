/**
 * Behavior tests for the TPS bot's play logic. Run:
 *   node --import tsx --test scripts/blackjackTpsBot.test.ts
 * (Not under the default `src/**` test glob; run explicitly.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { core, protocols, proof } from "../src/index.ts";
import { getPlayerParty, WAGER } from "../src/protocol/blackjack.ts";
import { partyToMove, playBoundedRounds, parseAllTunnelIds } from "./blackjackTpsBot.ts";

const TUNNEL_ID = "0x7"; // wire.ts requires a valid hex address (short is left-padded)

function freshTunnel(stake: bigint) {
  const proto = new protocols.BlackjackProtocol();
  const a = core.generateKeyPair();
  const b = core.generateKeyPair();
  const tunnel = core.OffchainTunnel.selfPlay(proto, TUNNEL_ID, a, b, "0xa", "0xb", {
    a: stake,
    b: stake,
  });
  return { proto, tunnel };
}

test("partyToMove follows the player party that alternates every two rounds", () => {
  // Rounds 1,2 => player A ; rounds 3,4 => player B (getPlayerParty owns this rule).
  assert.equal(partyToMove({ phase: "player", round: 1n }), "A");
  assert.equal(partyToMove({ phase: "dealer", round: 1n }), "B");
  assert.equal(partyToMove({ phase: "player", round: 3n }), "B");
  assert.equal(partyToMove({ phase: "dealer", round: 3n }), "A");
  // round_over hands off to NEXT round's player.
  assert.equal(partyToMove({ phase: "round_over", round: 2n }), getPlayerParty(3n));
});

test("playBoundedRounds plays exactly the requested number of hands past round 2", () => {
  // Catches the naive phase->party bug, which stalls once the player party flips at round 3.
  const { proto, tunnel } = freshTunnel(WAGER * 11n); // big enough to survive an all-loss streak
  const transcript = new proof.Transcript(TUNNEL_ID);
  tunnel.onUpdate = (u) => transcript.append(u);

  const r = playBoundedRounds(tunnel, proto, 10, 0n);

  assert.equal(r.rounds, 10, "should complete all 10 hands");
  assert.ok(r.updates >= 10, "each hand produces at least one co-signed update");
  assert.equal(transcript.length, r.updates, "every update is anchored in the transcript");
});

test("playBoundedRounds stops early when the game goes terminal", () => {
  // Stake covers exactly the wager: a single loss leaves a side unable to fund, so the
  // game must terminate before reaching maxRounds.
  const { proto, tunnel } = freshTunnel(WAGER);
  const r = playBoundedRounds(tunnel, proto, 1000, 0n);
  assert.ok(r.rounds < 1000, "should terminate before the requested cap");
  assert.ok(proto.isTerminal(tunnel.state), "ends on a terminal state");
});

test("parseAllTunnelIds returns every created Tunnel object (batch-safe)", () => {
  const changes = [
    { type: "created", objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>", objectId: "0x1" },
    { type: "mutated", objectType: "0x2::coin::Coin<0x2::sui::SUI>", objectId: "0x9" },
    { type: "created", objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>", objectId: "0x2" },
  ];
  assert.deepEqual(parseAllTunnelIds(changes), ["0x1", "0x2"]);
  assert.deepEqual(parseAllTunnelIds(null), []);
});
