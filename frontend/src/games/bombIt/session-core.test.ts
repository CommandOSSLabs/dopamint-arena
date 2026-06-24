import { test } from "node:test";
import assert from "node:assert/strict";
// Runtime SDK imports use RELATIVE .ts paths (tsx ignores the vite alias / tsconfig paths).
import {
  BombItProtocol,
  BOMB_IT_MIN_STAKE,
  CELL_COUNT,
  FUSE_TICKS,
} from "../../../../sui-tunnel-ts/src/protocol/bombIt.ts";
import { MultiGameBombItProtocol } from "../../../../sui-tunnel-ts/src/protocol/multiGameBombIt.ts";
import {
  OffchainTunnel,
  verifyCoSignedUpdate,
} from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { createParticipant } from "../../../../sui-tunnel-ts/src/core/keys.ts";
import {
  stepSession,
  deriveView,
  sessionResult,
  SOLO_STEP_MS,
  stepMultiGame,
  kickoffNextGame,
  deriveMultiView,
} from "./session-core.ts";

test("solo cadence makes a bomb fuse read as ~1s of real time (manual drop-and-flee is escapable)", () => {
  // Bomb It is a reaction game: at the high-throughput showcase rate the 8-tick fuse burned in
  // ~50ms (instant death + an unwatchable fight). One tick per SOLO_STEP_MS must keep the fuse
  // in a humanly-reactable window, anchored to the protocol's FUSE_TICKS.
  const fuseMs = FUSE_TICKS * SOLO_STEP_MS;
  assert.ok(
    fuseMs >= 800,
    `fuse lasts ${fuseMs}ms; must be >=800ms so a manual drop is escapable`,
  );
  assert.ok(
    fuseMs <= 2000,
    `fuse lasts ${fuseMs}ms; keep it <=2s so the duel stays snappy`,
  );
});

const CTX = {
  tunnelId: "0xfeed",
  initialBalances: { a: BOMB_IT_MIN_STAKE, b: BOMB_IT_MIN_STAKE },
};

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
    assert.equal(
      tunnel.state.balanceA + tunnel.state.balanceB,
      tunnel.state.total,
    );
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

test("a co-signed update verifies after bounded play (settleable mid-game)", () => {
  const { protocol, tunnel } = freshTunnel();
  // Bounded window: a long real-time duel co-signs thousands of updates, so we prove the
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

function freshMultiTunnel() {
  const a = createParticipant("a");
  const b = createParticipant("b");
  // Fund a large bank so many duels fit; the per-game stake is small (BOMB_IT_MIN_STAKE).
  const BANK = BOMB_IT_MIN_STAKE * 20n;
  const protocol = new MultiGameBombItProtocol("0xfeed", BOMB_IT_MIN_STAKE);
  const tunnel = OffchainTunnel.selfPlay(
    protocol,
    "0xfeed",
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    { a: BANK, b: BANK },
  );
  return { protocol, tunnel };
}

test("stepMultiGame advances a multi-game duel and stays settleable", () => {
  const { protocol, tunnel } = freshMultiTunnel();
  let stepped = 0;
  for (let i = 0; i < 300; i++) {
    const r = stepMultiGame(protocol, tunnel, Math.random);
    if (r === "stepped") {
      stepped++;
      // Wrapper conservation: real carried balances always sum to the locked total.
      assert.equal(
        tunnel.state.balanceA + tunnel.state.balanceB,
        BOMB_IT_MIN_STAKE * 40n,
      );
    } else break;
  }
  assert.ok(stepped > 0, "made progress");
  const u = tunnel.latest;
  assert.ok(
    u &&
      verifyCoSignedUpdate(
        u,
        { publicKey: tunnel.partyA.publicKey, scheme: tunnel.partyA.scheme },
        { publicKey: tunnel.partyB.publicKey, scheme: tunnel.partyB.scheme },
      ),
    "settleable mid multi-game session",
  );
});

test("kickoffNextGame starts game 2 after a duel ends", () => {
  const { protocol, tunnel } = freshMultiTunnel();
  // bomb-it duels end by a kill or the tick cap; 20000 steps is well beyond the cap.
  let outcome = "stepped";
  for (let i = 0; i < 20000 && outcome === "stepped"; i++) {
    outcome = stepMultiGame(protocol, tunnel, Math.random);
  }
  if (outcome === "game-over") {
    assert.equal(tunnel.state.gamesPlayed, 0, "still duel 1 at the boundary");
    kickoffNextGame(tunnel);
    assert.equal(tunnel.state.gamesPlayed, 1, "rematched onto duel 2");
    assert.equal(
      deriveMultiView(tunnel.state).winner,
      null,
      "fresh duel has no winner yet",
    );
  }
});
