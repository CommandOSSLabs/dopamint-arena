import { test } from "node:test";
import assert from "node:assert/strict";

// Relative SDK imports (runtime): tsx needs no path-alias config this way.
import { createParticipant } from "../../../../sui-tunnel-ts/src/core/keys.ts";
import { OffchainTunnel, verifyCoSignedUpdate } from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { BlackjackProtocol } from "../../../../sui-tunnel-ts/src/protocol/blackjack.ts";

import { partyForPhase, stepSession, deriveView, sessionResult } from "./session-core.ts";

function newTunnel(stake: bigint) {
  const a = createParticipant("player-bot");
  const b = createParticipant("dealer-bot");
  const protocol = new BlackjackProtocol();
  const tunnel = OffchainTunnel.selfPlay(
    protocol,
    "0x" + "bb".repeat(32),
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    { a: stake, b: stake },
  );
  return { protocol, tunnel };
}

test("partyForPhase routes turns: dealer->B, else A", () => {
  assert.equal(partyForPhase("player"), "A");
  assert.equal(partyForPhase("round_over"), "A");
  assert.equal(partyForPhase("dealer"), "B");
});

test("stepSession drives the tunnel to a terminal state, conserving balances", () => {
  const stake = 500n;
  const { protocol, tunnel } = newTunnel(stake);
  let guard = 0;
  while (stepSession(protocol, tunnel, Math.random)) {
    assert.equal(tunnel.state.balanceA + tunnel.state.balanceB, stake * 2n);
    if (++guard > 100_000) throw new Error("did not terminate");
  }
  assert.ok(protocol.isTerminal(tunnel.state), "reached terminal state");
  assert.equal(tunnel.state.balanceA + tunnel.state.balanceB, stake * 2n);
});

test("the latest co-signed update verifies after play", () => {
  const { protocol, tunnel } = newTunnel(500n);
  while (stepSession(protocol, tunnel, Math.random)) {}
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

test("deriveView and sessionResult report the bankroll outcome", () => {
  const stake = 500n;
  const { protocol, tunnel } = newTunnel(stake);
  while (stepSession(protocol, tunnel, Math.random)) {}
  const view = deriveView(tunnel.state, stake);
  assert.equal(view.playerCards.length, view.playerCardCount);
  assert.ok(["win", "lose", "push"].includes(sessionResult(tunnel.state, stake)));
});
