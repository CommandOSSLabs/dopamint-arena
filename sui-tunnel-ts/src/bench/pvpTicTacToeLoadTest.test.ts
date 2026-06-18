import { test } from "node:test";
import assert from "node:assert";
import { generateKeyPair, ed25519Address } from "../core/crypto";
import { defaultBackend } from "../core/crypto-native";
import { makeEndpoint } from "../core/tunnel";
import { Transport, DistributedTunnel } from "../core/distributedTunnel";
import {
  TicTacToeProtocol,
  TicTacToeState,
  TicTacToeMove,
} from "../protocol/ticTacToe";
import { playGame, runLoadTest, runPair } from "./pvpTicTacToeLoadTest";
import { createMetrics } from "./pvpMetrics";

/** Two transports wired so a.send delivers to b's handler and vice-versa (synchronous). */
function makeLoopback(): { a: Transport; b: Transport } {
  let aCb: ((f: Uint8Array) => void) | null = null;
  let bCb: ((f: Uint8Array) => void) | null = null;
  return {
    a: {
      send: (f) => bCb?.(f),
      onFrame: (cb) => {
        aCb = cb;
      },
    },
    b: {
      send: (f) => aCb?.(f),
      onFrame: (cb) => {
        bCb = cb;
      },
    },
  };
}

function buildTunnels() {
  const backend = defaultBackend();
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const addrA = ed25519Address(keyA.publicKey);
  const addrB = ed25519Address(keyB.publicKey);
  const protocol = new TicTacToeProtocol();
  const loop = makeLoopback();

  const tunnelA = new DistributedTunnel<TicTacToeState, TicTacToeMove>(
    protocol,
    {
      tunnelId: "0x" + "00".repeat(32),
      self: makeEndpoint(backend, addrA, keyA, true),
      opponent: makeEndpoint(backend, addrB, keyB, false),
      selfParty: "A",
    },
    loop.a,
    { a: 1000n, b: 1000n }
  );
  const tunnelB = new DistributedTunnel<TicTacToeState, TicTacToeMove>(
    protocol,
    {
      tunnelId: "0x" + "00".repeat(32),
      self: makeEndpoint(backend, addrB, keyB, true),
      opponent: makeEndpoint(backend, addrA, keyA, false),
      selfParty: "B",
    },
    loop.b,
    { a: 1000n, b: 1000n }
  );

  return { tunnelA, tunnelB, protocol };
}

test("playGame runs a full deterministic tic-tac-toe game", async () => {
  const { tunnelA, tunnelB, protocol } = buildTunnels();
  const metrics = createMetrics();

  const finished = await playGame(
    tunnelA,
    tunnelB,
    protocol,
    metrics,
    Date.now() + 5000
  );

  assert.strictEqual(finished, true);
  assert.ok(protocol.isTerminal(tunnelA.state));
  assert.strictEqual(tunnelA.state.winner, tunnelB.state.winner);
  assert.ok(metrics.actionsTotal > 0);
  assert.strictEqual(metrics.actionsTotal, metrics.latencyHistogramMs.length);
  assert.ok(metrics.latencyHistogramMs.every((ms) => ms >= 0));

  if (finished) {
    metrics.matchesCompleted++;
  }
  assert.strictEqual(metrics.matchesCompleted, 1);
});

test("runLoadTest with zero pairs returns zeroed metrics", async () => {
  const metrics = await runLoadTest({
    backendUrl: "ws://localhost:8080/v1/mp",
    pairs: 0,
    durationMs: 1000,
  });
  assert.strictEqual(metrics.actionsTotal, 0);
  assert.strictEqual(metrics.matchesCompleted, 0);
  assert.strictEqual(metrics.errors, 0);
  assert.deepStrictEqual(metrics.latencyHistogramMs, []);
  assert.deepStrictEqual(metrics.actionsPerSecond, []);
});

test("runPair is exported with the expected signature", () => {
  assert.strictEqual(typeof runPair, "function");
  assert.strictEqual(runPair.length, 4);
});
