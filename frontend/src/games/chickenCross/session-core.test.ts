import { test } from "node:test";
import assert from "node:assert/strict";
// Runtime SDK imports use RELATIVE .ts paths (tsx ignores the vite alias / tsconfig paths at
// runtime). This mirrors frontend/src/games/blackjack/session-core.test.ts exactly.
import { CrossProtocol, MIN_STAKE } from "../../../../sui-tunnel-ts/src/protocol/cross.ts";
import { OffchainTunnel } from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { createParticipant } from "../../../../sui-tunnel-ts/src/core/keys.ts";
import { stepSession, deriveView, sessionResult } from "./session-core.ts";

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
