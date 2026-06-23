import { test } from "node:test";
import assert from "node:assert/strict";
// Runtime SDK imports use RELATIVE .ts paths (tsx ignores the vite alias / tsconfig paths at
// runtime). This mirrors frontend/src/games/blackjack/session-core.test.ts exactly.
import {
  CrossProtocol,
  MIN_STAKE,
} from "../../../../sui-tunnel-ts/src/protocol/cross.ts";
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

test("stepSession advances the tunnel and stops at terminal", () => {
  const { protocol, tunnel } = freshTunnel();
  let steps = 0;
  while (stepSession(protocol, tunnel, Math.random) && steps < 1000) steps++;
  assert.equal(protocol.isTerminal(tunnel.state), true);
});

test("deriveView flattens players and balances to numbers", () => {
  const { tunnel } = freshTunnel();
  const v = deriveView(tunnel.state);
  assert.equal(v.players.length, 2);
  assert.equal(typeof v.players[0].lane, "number");
  assert.equal(typeof v.balanceA, "number");
  assert.equal(typeof v.seed, "number");
});

test("sessionResult maps a terminal state to A | B | push", () => {
  const { protocol, tunnel } = freshTunnel();
  while (stepSession(protocol, tunnel, Math.random)) {
    /* run to terminal */
  }
  const r = sessionResult(tunnel.state);
  assert.ok(r === "A" || r === "B" || r === "push");
});
