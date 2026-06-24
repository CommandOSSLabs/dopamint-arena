/**
 * Single-threaded, duration-based off-chain TPS driver — NO worker_threads.
 *
 * The winning scale-out model: run ONE process per vCPU (a shell launches N of
 * these) instead of one process with N worker threads. node worker_threads carry
 * per-worker overhead, and bun's worker_threads collapse/core-dump past ~16 on
 * Linux — but bun's ed25519 is ~2.3x node's, so N single-threaded bun processes
 * capture that win and scale cleanly. Forces nativeBackend (byte-identical sigs).
 *
 * Usage (one process): bun dist/bench/solo.js blackjack full 20000 <seed>
 * Fan out: launch one per core with distinct seeds, sum each STEPS_PER_S line.
 */
import { GAME_KITS, type BotContext, type GameId, type Party } from "@/agent/gameKit";
import { OffchainTunnel, type SignMode } from "sui-tunnel-ts/core/tunnel";
import { ParticipantRegistry } from "sui-tunnel-ts/core/keys";
import { mulberry32 } from "sui-tunnel-ts/sim/rng";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { blake2b256 } from "sui-tunnel-ts/core/crypto";
import { nativeBackend } from "sui-tunnel-ts/core/crypto-native";
import type { Balances } from "sui-tunnel-ts/protocol/Protocol";

const gameId = (process.argv[2] as GameId) ?? "blackjack";
const mode = (process.argv[3] as SignMode) ?? "full";
const durationMs = Number(process.argv[4] ?? 20000);
const seed = Number(process.argv[5] ?? 1);

const enc = new TextEncoder();
const kit = GAME_KITS[gameId];
const registry = new ParticipantRegistry(mulberry32(seed));
let idx = 0;

function open() {
  const i = idx++;
  const a = registry.create(`s${seed}-${i}-a`);
  const b = registry.create(`s${seed}-${i}-b`);
  const tid = "0x" + toHex(blake2b256(enc.encode(`solo-${seed}-${gameId}-${i}`)));
  const stake = kit.defaultStake;
  const bal: Balances = { a: stake * 10n, b: stake * 10n };
  const tunnel = OffchainTunnel.selfPlay(kit.protocol, tid, a.keyPair, b.keyPair, a.address, b.address, bal, nativeBackend);
  const ctx: BotContext = { rngForSeat: () => mulberry32(seed + i + 1) };
  return { tunnel, botA: kit.createBot("A", ctx), botB: kit.createBot("B", ctx), last: { A: null, B: null } as Record<Party, string | null> };
}

const SEATS = ["A", "B"] as Party[];
let slot = open();
let steps = 0;
const t0 = Date.now();
const deadline = t0 + durationMs;
while (true) {
  if (kit.protocol.isTerminal(slot.tunnel.state)) { slot = open(); }
  const state = slot.tunnel.state;
  const h = kit.stateHash(state);
  for (const seat of SEATS) {
    if (slot.last[seat] === h) continue;
    const bot = seat === "A" ? slot.botA : slot.botB;
    const move = bot.plan(state);
    if (move === null) continue;
    slot.tunnel.step(move, seat, { mode });
    bot.confirm(state, move);
    slot.last[seat] = h;
    steps++;
  }
  // Check the duration deadline only every 1024 steps to avoid Date.now() overhead.
  if ((steps & 1023) === 0 && Date.now() >= deadline) break;
}
const dt = (Date.now() - t0) / 1000;
console.log(`STEPS_PER_S=${Math.round(steps / dt)}`);
