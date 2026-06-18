/**
 * PvP tic-tac-toe load generator: pairs two `PvpClient`s through the backend
 * matchmaker, builds a `DistributedTunnel` per seat, and plays deterministic
 * tic-tac-toe games for the configured duration.
 */
import { PvpClient } from "./pvpClient";
import { DistributedTunnel } from "../core/distributedTunnel";
import {
  TicTacToeProtocol,
  TicTacToeState,
  TicTacToeMove,
} from "../protocol/ticTacToe";
import { makeEndpoint } from "../core/tunnel";
import { generateKeyPair, ed25519Address } from "../core/crypto";
import { defaultBackend } from "../core/crypto-native";
import {
  createMetrics,
  recordLatency,
  startBucketEmitter,
  PvpMetrics,
} from "./pvpMetrics";
import { CoSignedUpdate } from "../core/tunnel";
import { Protocol } from "../protocol/Protocol";

export interface LoadTestConfig {
  backendUrl: string;
  pairs: number;
  durationMs: number;
}

interface MatchInfo {
  matchId: string;
  role: "A" | "B";
  opponentWallet: string;
}

const MATCHMAKING_TIMEOUT_MS = 30_000;
const MOVE_TIMEOUT_MS = 5_000;

function deferredMatch(): {
  promise: Promise<MatchInfo>;
  resolve: (m: MatchInfo) => void;
} {
  let resolve!: (m: MatchInfo) => void;
  const promise = new Promise<MatchInfo>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timeout after ${ms}ms`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function createPvpClient(
  url: string,
  wallet: string,
  secretKey: Uint8Array,
  onMatch: (m: MatchInfo) => void
): PvpClient {
  return new PvpClient({
    url,
    wallet,
    secretKey,
    onMatchFound: (matchId, role, opponentWallet) => {
      onMatch({ matchId, role, opponentWallet });
    },
  });
}

export async function runLoadTest(cfg: LoadTestConfig): Promise<PvpMetrics> {
  const metrics = createMetrics();
  const stopBuckets = startBucketEmitter(metrics, 1000, (c) => {
    console.log(`actions/sec: ${c}`);
  });

  const pairTasks = Array.from({ length: cfg.pairs }, (_, i) =>
    runPair(cfg.backendUrl, i, metrics, cfg.durationMs)
  );

  try {
    await Promise.all(pairTasks);
  } finally {
    stopBuckets();
  }
  return metrics;
}

/**
 * Play one deterministic tic-tac-toe game through the two tunnels until the
 * game ends or the deadline is reached. Each co-signed update increments
 * `metrics.actionsTotal` exactly once and records the proposer's latency as
 * the time from `propose` to the first co-signed confirmation of that nonce.
 */
export async function playGame(
  tunnelA: DistributedTunnel<TicTacToeState, TicTacToeMove>,
  tunnelB: DistributedTunnel<TicTacToeState, TicTacToeMove>,
  protocol: Protocol<TicTacToeState, TicTacToeMove>,
  metrics: PvpMetrics,
  deadlineMs: number
): Promise<boolean> {
  const seenNonces = new Set<number>();
  const moveStartA = new Map<number, number>();
  const moveStartB = new Map<number, number>();
  const pendingConfirmations = new Map<
    number,
    { resolve: () => void; reject: (e: Error) => void }
  >();

  function onConfirmed(update: CoSignedUpdate) {
    const nonce = Number(update.update.nonce);
    if (seenNonces.has(nonce)) return;
    seenNonces.add(nonce);
    metrics.actionsTotal++;

    const start = moveStartA.get(nonce) ?? moveStartB.get(nonce);
    if (start !== undefined) {
      recordLatency(metrics, Date.now() - start);
    }

    const pending = pendingConfirmations.get(nonce);
    if (pending) {
      pending.resolve();
      pendingConfirmations.delete(nonce);
    }
  }

  tunnelA.onConfirmed = onConfirmed;
  tunnelB.onConfirmed = onConfirmed;

  function waitForConfirmation(nonce: number, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingConfirmations.delete(nonce);
        reject(new Error(`move ${nonce} confirmation timeout after ${ms}ms`));
      }, ms);
      pendingConfirmations.set(nonce, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  try {
    while (Date.now() < deadlineMs) {
      if (protocol.isTerminal(tunnelA.state)) {
        return true;
      }

      const turn = tunnelA.state.turn;
      const tunnel = turn === "A" ? tunnelA : tunnelB;
      const board = tunnelA.state.board;
      const cell = board.findIndex((cell) => cell === 0);
      if (cell === -1) {
        return true;
      }

      const nonce = Number(tunnel.nonce + 1n);
      const startMap = turn === "A" ? moveStartA : moveStartB;
      startMap.set(nonce, Date.now());
      const confirmPromise = waitForConfirmation(nonce, MOVE_TIMEOUT_MS);
      tunnel.propose({ cell }, BigInt(Date.now()));

      try {
        await confirmPromise;
      } catch (err) {
        metrics.errors++;
        return false;
      }
    }
    return false;
  } finally {
    tunnelA.onConfirmed = undefined;
    tunnelB.onConfirmed = undefined;
    pendingConfirmations.clear();
  }
}

export async function runPair(
  backendUrl: string,
  pairIndex: number,
  metrics: PvpMetrics,
  durationMs: number
): Promise<void> {
  const endTime = Date.now() + durationMs;

  while (Date.now() < endTime) {
    const keyA = generateKeyPair();
    const keyB = generateKeyPair();
    const addrA = ed25519Address(keyA.publicKey);
    const addrB = ed25519Address(keyB.publicKey);

    const matchA = deferredMatch();
    const matchB = deferredMatch();

    let clientA: PvpClient | undefined;
    let clientB: PvpClient | undefined;

    try {
      clientA = createPvpClient(backendUrl, addrA, keyA.secretKey, (m) =>
        matchA.resolve(m)
      );
      clientB = createPvpClient(backendUrl, addrB, keyB.secretKey, (m) =>
        matchB.resolve(m)
      );

      await withTimeout(
        Promise.all([clientA.ready, clientB.ready]),
        MATCHMAKING_TIMEOUT_MS,
        "client_ready"
      );
      clientA.joinQueue("tictactoe");
      clientB.joinQueue("tictactoe");

      const [infoA, infoB] = await withTimeout(
        Promise.all([matchA.promise, matchB.promise]),
        MATCHMAKING_TIMEOUT_MS,
        "matchmaking"
      );
      if (infoA.matchId !== infoB.matchId) {
        throw new Error(
          `pair ${pairIndex}: match id mismatch (${infoA.matchId} vs ${infoB.matchId})`
        );
      }
      const matchId = infoA.matchId;

      const backend = defaultBackend();
      const endpointA = makeEndpoint(backend, addrA, keyA, true);
      const endpointB = makeEndpoint(backend, addrB, keyB, true);

      const protocol = new TicTacToeProtocol();
      const tunnelA = new DistributedTunnel<TicTacToeState, TicTacToeMove>(
        protocol,
        {
          tunnelId: matchId,
          self: endpointA,
          opponent: endpointB,
          selfParty: infoA.role,
        },
        clientA.getTransport(),
        { a: 1000n, b: 1000n }
      );
      const tunnelB = new DistributedTunnel<TicTacToeState, TicTacToeMove>(
        protocol,
        {
          tunnelId: matchId,
          self: endpointB,
          opponent: endpointA,
          selfParty: infoB.role,
        },
        clientB.getTransport(),
        { a: 1000n, b: 1000n }
      );

      const finished = await playGame(
        tunnelA,
        tunnelB,
        protocol,
        metrics,
        endTime
      );
      if (finished) {
        metrics.matchesCompleted++;
      }
    } catch (err) {
      metrics.errors++;
      console.error(`pair ${pairIndex} error:`, err);
      break;
    } finally {
      clientA?.close();
      clientB?.close();
    }
  }
}
