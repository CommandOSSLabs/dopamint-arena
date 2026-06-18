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
import { generateKeyPair, ed25519Address, KeyPair } from "../core/crypto";
import { defaultBackend } from "../core/crypto-native";
import {
  createMetrics,
  recordLatency,
  startBucketEmitter,
  PvpMetrics,
} from "./pvpMetrics";
import { CoSignedUpdate } from "../core/tunnel";
import { blake2b256 } from "../core/crypto";
import { bytesToHex } from "@noble/hashes/utils";
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

interface ClientSlot {
  client: PvpClient;
  keyPair: KeyPair;
  wallet: string;
  busy: boolean;
}

const MATCHMAKING_TIMEOUT_MS = 30_000;
const MOVE_TIMEOUT_MS = 5_000;
const textEncoder = new TextEncoder();

/** Convert an arbitrary backend match id into a deterministic 32-byte Sui address. */
function tunnelIdFromMatchId(matchId: string): string {
  return "0x" + bytesToHex(blake2b256(textEncoder.encode(matchId)));
}

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

  if (cfg.pairs <= 0) {
    stopBuckets();
    return metrics;
  }

  const deadline = Date.now() + cfg.durationMs;
  const slots: ClientSlot[] = [];
  const pendingMatches = new Map<string, { a?: ClientSlot; b?: ClientSlot }>();
  const activeGames = new Set<Promise<void>>();

  function trackGame(promise: Promise<void>): void {
    activeGames.add(promise);
    promise.finally(() => activeGames.delete(promise));
  }

  function recreateClient(slot: ClientSlot): PvpClient {
    slot.client.close();
    slot.keyPair = generateKeyPair();
    slot.wallet = ed25519Address(slot.keyPair.publicKey);
    return new PvpClient({
      url: cfg.backendUrl,
      wallet: slot.wallet,
      secretKey: slot.keyPair.secretKey,
      onMatchFound: (matchId, role, opponentWallet) => {
        handleMatchFound(slot, matchId, role, opponentWallet);
      },
      onError: (code) => {
        metrics.errors++;
        console.error(`client ${slot.wallet} error: ${code}`);
      },
    });
  }

  function startGame(aSlot: ClientSlot, bSlot: ClientSlot, matchId: string) {
    if (aSlot.busy || bSlot.busy) {
      return;
    }
    aSlot.busy = true;
    bSlot.busy = true;

    const promise = (async () => {
      try {
        const backend = defaultBackend();
        const endpointA = makeEndpoint(backend, aSlot.wallet, aSlot.keyPair, true);
        const endpointB = makeEndpoint(backend, bSlot.wallet, bSlot.keyPair, true);
        const opponentForA = makeEndpoint(
          backend,
          bSlot.wallet,
          bSlot.keyPair,
          false
        );
        const opponentForB = makeEndpoint(
          backend,
          aSlot.wallet,
          aSlot.keyPair,
          false
        );

        const protocol = new TicTacToeProtocol();
        const tunnelA = new DistributedTunnel<TicTacToeState, TicTacToeMove>(
          protocol,
          {
            tunnelId: tunnelIdFromMatchId(matchId),
            self: endpointA,
            opponent: opponentForA,
            selfParty: "A",
          },
          aSlot.client.getTransport(),
          { a: 1000n, b: 1000n }
        );
        const tunnelB = new DistributedTunnel<TicTacToeState, TicTacToeMove>(
          protocol,
          {
            tunnelId: tunnelIdFromMatchId(matchId),
            self: endpointB,
            opponent: opponentForB,
            selfParty: "B",
          },
          bSlot.client.getTransport(),
          { a: 1000n, b: 1000n }
        );

        const finished = await playGame(
          tunnelA,
          tunnelB,
          protocol,
          metrics,
          deadline
        );
        if (finished) {
          metrics.matchesCompleted++;
        }
      } catch (err) {
        metrics.errors++;
        console.error(`match ${matchId} error:`, err);
      } finally {
        aSlot.busy = false;
        bSlot.busy = false;
        if (Date.now() < deadline) {
          aSlot.client = recreateClient(aSlot);
          bSlot.client = recreateClient(bSlot);
          await Promise.all([aSlot.client.ready, bSlot.client.ready]);
          aSlot.client.joinQueue("tictactoe");
          bSlot.client.joinQueue("tictactoe");
        }
      }
    })();

    trackGame(promise);
  }

  function handleMatchFound(
    slot: ClientSlot,
    matchId: string,
    role: "A" | "B",
    _opponentWallet: string
  ) {
    if (slot.busy) {
      return;
    }
    const entry = pendingMatches.get(matchId) ?? {};
    const ownKey = role === "A" ? "a" : "b";
    const otherKey = role === "A" ? "b" : "a";

    if (entry[otherKey]) {
      const aSlot = role === "A" ? slot : entry[otherKey]!;
      const bSlot = role === "A" ? entry[otherKey]! : slot;
      pendingMatches.delete(matchId);
      startGame(aSlot, bSlot, matchId);
    } else {
      entry[ownKey] = slot;
      pendingMatches.set(matchId, entry);
    }
  }

  for (let i = 0; i < cfg.pairs * 2; i++) {
    const keyPair = generateKeyPair();
    const wallet = ed25519Address(keyPair.publicKey);
    const slot: ClientSlot = {
      keyPair,
      wallet,
      busy: false,
    } as unknown as ClientSlot;

    const client = new PvpClient({
      url: cfg.backendUrl,
      wallet,
      secretKey: keyPair.secretKey,
      onMatchFound: (matchId, role, opponentWallet) => {
        handleMatchFound(slot, matchId, role, opponentWallet);
      },
      onError: (code) => {
        metrics.errors++;
        console.error(`client ${wallet} error: ${code}`);
      },
    });

    slot.client = client;
    slots.push(slot);
  }

  try {
    await Promise.all(slots.map((s) => s.client.ready));
    for (const slot of slots) {
      slot.client.joinQueue("tictactoe");
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, cfg.durationMs);
    });

    // Let active games finish so actions they already committed are counted.
    await Promise.all([...activeGames]);
  } finally {
    stopBuckets();
    for (const slot of slots) {
      slot.client.close();
    }
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

  function onConfirmed(party: "A" | "B", update: CoSignedUpdate) {
    const nonce = Number(update.update.nonce);

    const startMap = party === "A" ? moveStartA : moveStartB;
    const start = startMap.get(nonce);
    if (start !== undefined) {
      recordLatency(metrics, Date.now() - start);
      const pending = pendingConfirmations.get(nonce);
      if (pending) {
        pending.resolve();
        pendingConfirmations.delete(nonce);
      }
    }

    if (!seenNonces.has(nonce)) {
      seenNonces.add(nonce);
      metrics.actionsTotal++;
    }
  }

  tunnelA.onConfirmed = (update) => onConfirmed("A", update);
  tunnelB.onConfirmed = (update) => onConfirmed("B", update);

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
          tunnelId: tunnelIdFromMatchId(matchId),
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
          tunnelId: tunnelIdFromMatchId(matchId),
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
