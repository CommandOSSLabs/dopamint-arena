/**
 * Worker shard for the off-chain TPS benchmark.
 *
 * Each worker maintains a pool of concurrent `OffchainTunnel`s using one frontend
 * game kit, drives both seats with the kit's bots, and reports counters back to the
 * main thread. Tunnels are self-play: this process holds both keypairs, but every
 * transition is still dual-signed and verified just like a real tunnel.
 */

import { parentPort, workerData } from "node:worker_threads";
import { GAME_KITS, type BotContext, type GameId } from "@/agent/gameKit";
import { OffchainTunnel, type SignMode } from "sui-tunnel-ts/core/tunnel";
import { ParticipantRegistry } from "sui-tunnel-ts/core/keys";
import { mulberry32 } from "sui-tunnel-ts/sim/rng";
import {
  newCounters,
  type Counters,
} from "sui-tunnel-ts/telemetry/metrics";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { blake2b256, nobleBackend, type CryptoBackend } from "sui-tunnel-ts/core/crypto";
import { nativeBackend, defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import type { Party, Balances } from "sui-tunnel-ts/protocol/Protocol";

/**
 * Resolve a shard's crypto backend. "default" picks native (node:crypto, which is
 * BoringSSL under Bun) — the ~2x-faster path and the measured winner. "noble" is a
 * pure-JS escape hatch: only Bun + worker_threads at high counts can abort with the
 * native KeyObject path. The stable, fast Bun model is one single-thread process per
 * core (see solo.ts), where native is both fast and crash-free.
 */
function resolveBackend(name: string | undefined): CryptoBackend {
  if (name === "noble") return nobleBackend;
  if (name === "native") return nativeBackend;
  return defaultBackend();
}

export interface WorkerData {
  shardIndex: number;
  gameId: GameId;
  tunnels: number;
  signMode: SignMode;
  durationMs?: number;
  maxSteps?: number;
  seed: number;
  reportEveryMs: number;
  backend?: string;
}

export type WorkerMessage =
  | { type: "progress"; shard: number; counters: Counters }
  | { type: "done"; shard: number; counters: Counters }
  | { type: "error"; shard: number; error: string };

interface Slot {
  tunnel: OffchainTunnel<unknown, unknown>;
  botA: ReturnType<typeof GAME_KITS[GameId]["createBot"]>;
  botB: ReturnType<typeof GAME_KITS[GameId]["createBot"]>;
  lastHashes: Record<Party, string | null>;
  openIndex: number;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return h >>> 0;
}

const enc = new TextEncoder();

function makeRng(seed: number, shard: number, tunnel: number, seat: Party): () => number {
  // Mix all sources into a single 32-bit seed for mulberry32.
  const mix = seed ^ (shard * 374761393) ^ (tunnel * 668265263) ^ hashString(seat);
  return mulberry32(mix);
}

function makeBalances(stake: bigint): Balances {
  // 10× the stake is enough for the multi-game / betting protocols in our tests.
  const amount = stake * 10n;
  return { a: amount, b: amount };
}

function runShard(cfg: WorkerData): void {
  const kit = GAME_KITS[cfg.gameId];
  if (!kit) throw new Error(`unknown game id: ${cfg.gameId}`);

  const counters: Counters = newCounters();
  const rng = mulberry32(cfg.seed ^ cfg.shardIndex);
  const registry = new ParticipantRegistry(rng);
  const backend = resolveBackend(cfg.backend);

  let nextTunnelIndex = 0;

  const openSlot = (): Slot => {
    const i = nextTunnelIndex++;
    const a = registry.create(`s${cfg.shardIndex}-t${i}-a`);
    const b = registry.create(`s${cfg.shardIndex}-t${i}-b`);
    const tunnelId =
      "0x" +
      toHex(
        blake2b256(enc.encode(`dopamint-bench-${cfg.gameId}-${cfg.shardIndex}-${i}`)),
      );
    const initialBalances = makeBalances(kit.defaultStake);

    const tunnel = OffchainTunnel.selfPlay(
      kit.protocol,
      tunnelId,
      a.keyPair,
      b.keyPair,
      a.address,
      b.address,
      initialBalances,
      backend,
    );

    const ctx: BotContext = {
      rngForSeat: (seat) => makeRng(cfg.seed, cfg.shardIndex, i, seat),
    };

    counters.tunnelsOpened++;

    return {
      tunnel,
      botA: kit.createBot("A", ctx),
      botB: kit.createBot("B", ctx),
      lastHashes: { A: null, B: null },
      openIndex: i,
    };
  };

  const slots: Slot[] = [];
  for (let i = 0; i < cfg.tunnels; i++) slots.push(openSlot());

  const start = Date.now();
  let stepsDone = 0;

  const shouldStop = () => {
    if (cfg.durationMs !== undefined && Date.now() - start >= cfg.durationMs) return true;
    if (cfg.maxSteps !== undefined && stepsDone >= cfg.maxSteps) return true;
    return false;
  };

  const sendProgress = () => {
    parentPort?.postMessage({ type: "progress", shard: cfg.shardIndex, counters: { ...counters } });
  };

  const progressInterval = setInterval(sendProgress, cfg.reportEveryMs);

  try {
    outer: while (!shouldStop() && slots.length > 0) {
      for (let i = slots.length - 1; i >= 0; i--) {
        const slot = slots[i]!;

        // If this tunnel reached terminal, close it and immediately open a new one
        // so concurrency stays constant.
        if (kit.protocol.isTerminal(slot.tunnel.state)) {
          counters.tunnelsClosed++;
          slots[i] = openSlot();
          if (shouldStop()) break outer;
          continue;
        }

        const state = slot.tunnel.state;
        const h = kit.stateHash(state);

        for (const seat of ["A", "B"] as Party[]) {
          if (slot.lastHashes[seat] === h) continue;

          const bot = seat === "A" ? slot.botA : slot.botB;
          const move = bot.plan(state);
          if (move === null) continue;

          const res = slot.tunnel.step(move, seat, { mode: cfg.signMode });
          bot.confirm(state, move);

          counters.updates++;
          counters.signatures += cfg.signMode === "none" ? 0 : 2;
          counters.verifications += cfg.signMode === "full" ? 2 : 0;
          counters.bytes += res.messageBytes;

          slot.lastHashes[seat] = h;
          stepsDone++;

          if (shouldStop()) break outer;
        }
      }
    }
  } catch (err) {
    counters.errors++;
    parentPort?.postMessage({
      type: "error",
      shard: cfg.shardIndex,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearInterval(progressInterval);
    sendProgress();
    parentPort?.postMessage({ type: "done", shard: cfg.shardIndex, counters: { ...counters } });
  }
}

runShard(workerData as WorkerData);
