/**
 * Single-threaded profiling driver for the off-chain hot path.
 *
 * Replicates one offchainTpsWorker shard loop (open blackjack tunnel, drive both
 * seats, reopen on terminal) for a fixed step count, so a V8 CPU profile attributes
 * per-transition cost across protocol / serialize / hash / sign / verify / alloc.
 * Not a TPS benchmark — run under `node --cpu-prof`.
 */
import { GAME_KITS, type BotContext, type GameId, type Party } from "@/agent/gameKit";
import { OffchainTunnel, type SignMode } from "sui-tunnel-ts/core/tunnel";
import { ParticipantRegistry } from "sui-tunnel-ts/core/keys";
import { mulberry32 } from "sui-tunnel-ts/sim/rng";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { blake2b256, nobleBackend } from "sui-tunnel-ts/core/crypto";
import { nativeBackend } from "sui-tunnel-ts/core/crypto-native";
import type { Balances } from "sui-tunnel-ts/protocol/Protocol";

const gameId = (process.argv[2] as GameId) ?? "blackjack";
const mode = (process.argv[3] as SignMode) ?? "full";
const backend = process.argv[4] === "noble" ? nobleBackend : nativeBackend;
const TOTAL_STEPS = Number(process.argv[5] ?? 400000);

const enc = new TextEncoder();
const kit = GAME_KITS[gameId];
const registry = new ParticipantRegistry(mulberry32(1));
let idx = 0;

function open() {
  const i = idx++;
  const a = registry.create(`p-${i}-a`);
  const b = registry.create(`p-${i}-b`);
  const tid = "0x" + toHex(blake2b256(enc.encode(`prof-${gameId}-${i}`)));
  const stake = kit.defaultStake;
  const bal: Balances = { a: stake * 10n, b: stake * 10n };
  const tunnel = OffchainTunnel.selfPlay(kit.protocol, tid, a.keyPair, b.keyPair, a.address, b.address, bal, backend);
  const ctx: BotContext = { rngForSeat: () => mulberry32(i + 1) };
  return { tunnel, botA: kit.createBot("A", ctx), botB: kit.createBot("B", ctx), last: { A: null, B: null } as Record<Party, string | null> };
}

const SEATS = ["A", "B"] as Party[];
let slot = open();
let steps = 0;
const t0 = Date.now();
while (steps < TOTAL_STEPS) {
  if (kit.protocol.isTerminal(slot.tunnel.state)) { slot = open(); continue; }
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
    if (++steps >= TOTAL_STEPS) break;
  }
}
const dt = (Date.now() - t0) / 1000;
console.error(`profStep: ${gameId} ${mode} ${backend.name} — ${steps} steps in ${dt.toFixed(2)}s = ${Math.round(steps / dt).toLocaleString()} steps/s`);
