import { test } from "node:test";
import assert from "node:assert/strict";
// Runtime SDK imports use RELATIVE .ts paths (tsx ignores the vite alias / tsconfig paths at
// runtime). Same shape as the blackjack/bomb-it session-core tests: bounded advance +
// conservation here; full termination is covered by the protocol's own fast SDK tests.
import { CrossProtocol, MIN_STAKE } from "../../../../sui-tunnel-ts/src/protocol/cross.ts";
import { OffchainTunnel, verifyCoSignedUpdate } from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { createParticipant } from "../../../../sui-tunnel-ts/src/core/keys.ts";
import { stepSession, deriveView, sessionResult, visibleLanes } from "./session-core.ts";

const farApart = {
  tick: 100,
  seed: 1,
  players: [
    { lane: 50, col: 4, score: 50 },
    { lane: 5, col: 4, score: 5 },
  ],
  winner: null as "A" | "B" | null,
  balanceA: 100,
  balanceB: 100,
};

test("visibleLanes keeps YOUR chicken on screen when the opponent pulls far ahead", () => {
  const lanes = visibleLanes(farApart, 1); // you control seat B (index 1) at lane 5
  assert.ok(lanes.includes(5), "your chicken's lane must stay visible");
});

test("visibleLanes follows the leader when spectating a bot-vs-bot race", () => {
  const lanes = visibleLanes(farApart, null);
  assert.ok(lanes.includes(50), "the leading chicken is the camera anchor when spectating");
});

function freshTunnel() {
  const a = createParticipant("a");
  const b = createParticipant("b");
  const protocol = new CrossProtocol();
  const tunnel = OffchainTunnel.selfPlay(
    protocol,
    "0xfeed",
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    { a: MIN_STAKE, b: MIN_STAKE },
  );
  return { protocol, tunnel };
}

test("stepSession advances the race, conserving the staked pot each tick", () => {
  const { protocol, tunnel } = freshTunnel();
  // Long tick budget (~30s); assert advance + conservation over a bounded window. Termination
  // is covered by the protocol's fast (crypto-free) SDK tests; a full playout here would
  // co-sign thousands of real updates.
  for (let i = 0; i < 120; i++) {
    if (!stepSession(protocol, tunnel, Math.random)) break;
    assert.equal(tunnel.state.balanceA + tunnel.state.balanceB, tunnel.state.total);
  }
  assert.ok(tunnel.state.tick > 0n);
});

test("deriveView flattens players and balances to numbers", () => {
  const { tunnel } = freshTunnel();
  const v = deriveView(tunnel.state);
  assert.equal(v.players.length, 2);
  assert.equal(typeof v.players[0].lane, "number");
  assert.equal(typeof v.balanceA, "number");
  assert.equal(typeof v.seed, "number");
});

test("sessionResult maps winner to A | B | push", () => {
  const { tunnel } = freshTunnel();
  const s = tunnel.state;
  assert.equal(sessionResult({ ...s, winner: "A" }), "A");
  assert.equal(sessionResult({ ...s, winner: "B" }), "B");
  assert.equal(sessionResult({ ...s, winner: null }), "push"); // no winner ⇒ push
});

test("a co-signed update verifies after bounded play (settleable mid-game)", () => {
  const { protocol, tunnel } = freshTunnel();
  // Bounded window: a long real-time race co-signs thousands of updates, so we prove the
  // co-signed state is on-chain-settleable from a slice rather than a full playout.
  for (let i = 0; i < 50; i++) {
    if (!stepSession(protocol, tunnel, Math.random)) break;
  }
  const u = tunnel.latest;
  assert.ok(u, "has a co-signed update");
  assert.ok(
    verifyCoSignedUpdate(
      u!,
      { publicKey: tunnel.partyA.publicKey, scheme: tunnel.partyA.scheme },
      { publicKey: tunnel.partyB.publicKey, scheme: tunnel.partyB.scheme },
    ),
    "settleable co-signed state",
  );
});
