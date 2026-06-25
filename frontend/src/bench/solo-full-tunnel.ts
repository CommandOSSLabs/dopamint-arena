/**
 * Full tunnel-lifecycle benchmark driver.
 *
 * Same single-threaded, duration-based shape as solo.ts, but adds the missing
 * pieces of the off-chain tunnel lifecycle:
 *   1. Register a session with the backend control plane.
 *   2. Open a self-play off-chain tunnel (exactly like solo.ts).
 *   3. Run bots and accumulate a transcript of every co-signed update.
 *   4. Send coarse heartbeats to the backend session route (~every 1024 steps).
 *   5. When the game ends, build a co-signed root settlement off-chain.
 *   6. Submit that settlement to the backend `/settle` route so the backend can
 *      execute `close_cooperative_with_root` on-chain and archive the transcript.
 *
 * In this model the EC2 benchmark fleet acts as a client: it performs all the
 * off-chain work (moves, signatures, transcript root) and pushes proof/state
 * artifacts to the backend for settlement execution and stats aggregation.
 *
 * Usage (one process): bun dist/bench/solo-full-tunnel.js blackjack full 20000 <seed>
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
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { createControlPlaneClient } from "@/backend/controlPlane";
import { coSignedToSettleBody } from "@/backend/settleRequest";

const gameId = (process.argv[2] as GameId) ?? "blackjack";
const mode = (process.argv[3] as SignMode) ?? "full";
const durationMs = Number(process.argv[4] ?? 20000);
const seed = Number(process.argv[5] ?? 1);

const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";
const controlPlane = createControlPlaneClient(backendUrl);

const enc = new TextEncoder();
const kit = GAME_KITS[gameId];
const registry = new ParticipantRegistry(mulberry32(seed));
let idx = 0;

interface ActiveSlot {
  tunnel: OffchainTunnel<unknown, unknown>;
  botA: ReturnType<typeof kit.createBot>;
  botB: ReturnType<typeof kit.createBot>;
  last: Record<Party, string | null>;
  transcript: Transcript;
  sessionId: string;
  statsToken: string;
  actionsSinceHeartbeat: number;
  lastHeartbeatAt: number;
}

async function open(): Promise<ActiveSlot> {
  const i = idx++;
  const a = registry.create(`s${seed}-${i}-a`);
  const b = registry.create(`s${seed}-${i}-b`);
  const tid = "0x" + toHex(blake2b256(enc.encode(`solo-${seed}-${gameId}-${i}`)));
  const stake = kit.defaultStake;
  const bal: Balances = { a: stake * 10n, b: stake * 10n };

  const tunnel = OffchainTunnel.selfPlay(
    kit.protocol,
    tid,
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    bal,
    nativeBackend,
  );

  const transcript = new Transcript(tid);
  tunnel.onUpdate = (u) => transcript.append(u);

  const ctx: BotContext = { rngForSeat: () => mulberry32(seed + i + 1) };

  const { sessionId, statsToken } = await controlPlane.registerSession({
    userAddress: a.address,
    game: gameId,
    tunnels: [{ tunnelId: tid, partyA: a.address, partyB: b.address }],
  });

  return {
    tunnel,
    botA: kit.createBot("A", ctx),
    botB: kit.createBot("B", ctx),
    last: { A: null, B: null },
    transcript,
    sessionId,
    statsToken,
    actionsSinceHeartbeat: 0,
    lastHeartbeatAt: Date.now(),
  };
}

async function sendHeartbeat(slot: ActiveSlot): Promise<void> {
  if (slot.actionsSinceHeartbeat === 0) return;
  const now = Date.now();
  const windowMs = now - slot.lastHeartbeatAt;
  try {
    await controlPlane.sendHeartbeat(slot.sessionId, slot.statsToken, {
      tunnelId: slot.tunnel.tunnelId,
      nonce: String(slot.tunnel.latest?.update.nonce ?? 0),
      actionsDelta: slot.actionsSinceHeartbeat,
      windowMs,
    });
  } catch (e) {
    console.warn("[solo-full-tunnel] heartbeat failed:", e);
  }
  slot.actionsSinceHeartbeat = 0;
  slot.lastHeartbeatAt = now;
}

async function settle(slot: ActiveSlot): Promise<void> {
  const latest = slot.tunnel.latest;
  if (!latest) return;
  try {
    const timestamp = BigInt(Date.now());
    const root = slot.transcript.root();
    const settlement = slot.tunnel.buildSettlementWithRoot(timestamp, root, 0n);
    const body = coSignedToSettleBody(settlement, slot.transcript.rawEntries());
    await controlPlane.settle(slot.tunnel.tunnelId, body);
  } catch (e) {
    console.warn("[solo-full-tunnel] settle failed:", e);
  }
}

async function main() {
  let slot = await open();
  let steps = 0;
  const t0 = Date.now();
  const deadline = t0 + durationMs;

  while (true) {
    if (kit.protocol.isTerminal(slot.tunnel.state)) {
      await sendHeartbeat(slot);
      await settle(slot);
      slot = await open();
    }

    const state = slot.tunnel.state;
    const h = kit.stateHash(state);
    for (const seat of ["A", "B"] as Party[]) {
      if (slot.last[seat] === h) continue;
      const bot = seat === "A" ? slot.botA : slot.botB;
      const move = bot.plan(state);
      if (move === null) continue;
      slot.tunnel.step(move, seat, { mode });
      bot.confirm(state, move);
      slot.last[seat] = h;
      steps++;
      slot.actionsSinceHeartbeat++;
    }

    // Check the duration deadline only every 1024 steps to avoid Date.now() overhead.
    // Also flush heartbeat data at the same cadence.
    if ((steps & 1023) === 0) {
      if (Date.now() >= deadline) break;
      await sendHeartbeat(slot);
    }
  }

  await sendHeartbeat(slot);
  await settle(slot);

  const dt = (Date.now() - t0) / 1000;
  console.log(`STEPS_PER_S=${Math.round(steps / dt)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
