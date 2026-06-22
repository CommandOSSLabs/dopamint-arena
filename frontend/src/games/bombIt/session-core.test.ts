import { test } from "node:test";
import assert from "node:assert/strict";
// Runtime SDK imports use RELATIVE .ts paths (tsx ignores the vite alias / tsconfig paths).
import { BombItProtocol, BOMB_IT_MIN_STAKE, CELL_COUNT } from "../../../../sui-tunnel-ts/src/protocol/bombIt.ts";
import { OffchainTunnel } from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { createParticipant } from "../../../../sui-tunnel-ts/src/core/keys.ts";
import { stepSession, deriveView, sessionResult } from "./session-core.ts";

const CTX = { tunnelId: "0xfeed", initialBalances: { a: BOMB_IT_MIN_STAKE, b: BOMB_IT_MIN_STAKE } };

function freshTunnel() {
  const a = createParticipant("a");
  const b = createParticipant("b");
  const protocol = new BombItProtocol();
  const tunnel = OffchainTunnel.selfPlay(
    protocol,
    "0xfeed",
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    { a: BOMB_IT_MIN_STAKE, b: BOMB_IT_MIN_STAKE },
  );
  return { protocol, tunnel };
}

test("stepSession advances a bot-vs-bot match, conserving the staked pot each tick", () => {
  const { protocol, tunnel } = freshTunnel();
  // The arena runs a long tick budget (~30s); assert the driver advances + conserves over a
  // bounded window. Full-playout termination is covered by the protocol's own (crypto-free,
  // fast) SDK tests — running it here would co-sign thousands of real updates.
  for (let i = 0; i < 120; i++) {
    if (!stepSession(protocol, tunnel, Math.random)) break;
    assert.equal(tunnel.state.balanceA + tunnel.state.balanceB, tunnel.state.total);
  }
  assert.ok(tunnel.state.tick > 0n);
});

test("deriveView flattens grid, players, bombs, and balances to plain values", () => {
  const p = new BombItProtocol();
  const v = deriveView(p.initialState(CTX));
  assert.equal(v.grid.length, CELL_COUNT);
  assert.equal(v.players.length, 2);
  assert.equal(typeof v.balanceA, "number");
  assert.equal(v.bombs.length, 0);
  assert.equal(v.winner, null);
});

test("sessionResult reports the winning seat (and draws as draw)", () => {
  const p = new BombItProtocol();
  const s = p.initialState(CTX);
  assert.equal(sessionResult({ ...s, winner: "A" }), "A");
  assert.equal(sessionResult({ ...s, winner: "B" }), "B");
  assert.equal(sessionResult({ ...s, winner: "draw" }), "draw");
  assert.equal(sessionResult(s), "draw"); // in-progress (winner null) -> neutral draw
});
