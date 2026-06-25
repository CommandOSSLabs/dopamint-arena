/**
 * Batch full-lifecycle benchmark driver.
 *
 * Three distinct phases:
 *   1. OPEN   — on-chain create_and_fund a pool of shared tunnels in one PTB.
 *   2. PLAY   — pure off-chain stepping across the pool at full speed (no backend awaits).
 *   3. SETTLE — co-sign root settlements for every tunnel and submit them to the backend.
 *
 * This is the shape the user described: open everything, run the middle phase at ~50k TPS,
 * then settle through the backend. The ASG instances act as clients that produce the off-chain
 * work and push only the final settlements to the backend for on-chain execution + Walrus
 * transcript archival.
 *
 * Required env:
 *   SUI_FUNDER_KEY        — base64 suiprivkey of a funded account (opens + stakes + gas)
 *   BACKEND_URL           — tunnel-manager ALB base URL
 *   SUI_NETWORK           — "testnet" | "mainnet" | "localnet" (default "testnet")
 *   PACKAGE_ID            — deployed sui_tunnel package (optional, falls back to env default)
 *
 * Args: <gameId> <mode> <durationMs> <tunnelCount> <seed>
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
import { buildOpenAndFundMany } from "sui-tunnel-ts/onchain/createAndFund";
import { parseTunnelId } from "sui-tunnel-ts/onchain/lifecycle";
import { createSuiClient } from "sui-tunnel-ts/utils";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { createControlPlaneClient } from "@/backend/controlPlane";
import { coSignedToSettleBody } from "@/backend/settleRequest";

const gameId = (process.argv[2] as GameId) ?? "blackjack";
const mode = (process.argv[3] as SignMode) ?? "full";
const durationMs = Number(process.argv[4] ?? 20000);
const tunnelCount = Number(process.argv[5] ?? 10);
const seed = Number(process.argv[6] ?? 1);

const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";
const network = (process.env.SUI_NETWORK as "testnet" | "mainnet" | "localnet") ?? "testnet";
const packageId = process.env.PACKAGE_ID ?? "0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b";
process.env.PACKAGE_ID ??= packageId;

const controlPlane = createControlPlaneClient(backendUrl);
const client = createSuiClient(network);

const enc = new TextEncoder();
const kit = GAME_KITS[gameId];
const registry = new ParticipantRegistry(mulberry32(seed));

interface BotPair {
  coreA: ReturnType<typeof registry.create>;
  coreB: ReturnType<typeof registry.create>;
  suiA: Ed25519Keypair;
  suiB: Ed25519Keypair;
}

interface TunnelSlot {
  tunnelId: string;
  createdAt: bigint;
  tunnel: OffchainTunnel<unknown, unknown>;
  botA: ReturnType<typeof kit.createBot>;
  botB: ReturnType<typeof kit.createBot>;
  last: Record<Party, string | null>;
  transcript: Transcript;
  sessionId: string;
  statsToken: string;
}

function makeBotPair(): BotPair {
  const coreA = registry.create(`s${seed}-a`);
  const coreB = registry.create(`s${seed}-b`);
  const suiA = Ed25519Keypair.fromSecretKey(coreA.keyPair.secretKey);
  const suiB = Ed25519Keypair.fromSecretKey(coreB.keyPair.secretKey);
  return { coreA, coreB, suiA, suiB };
}

function parseAllTunnelIds(objectChanges: unknown): string[] {
  if (!Array.isArray(objectChanges)) return [];
  const ids: string[] = [];
  for (const c of objectChanges as Array<Record<string, unknown>>) {
    if (
      c.type === "created" &&
      typeof c.objectType === "string" &&
      c.objectType.includes("::tunnel::Tunnel<")
    ) {
      ids.push(c.objectId as string);
    }
  }
  return ids;
}

async function openPhase(funder: Ed25519Keypair): Promise<TunnelSlot[]> {
  const stake = kit.defaultStake;
  const pairs: BotPair[] = [];
  for (let i = 0; i < tunnelCount; i++) pairs.push(makeBotPair());

  const specs = pairs.map((p) => ({
    partyA: {
      address: p.coreA.address,
      publicKey: p.coreA.keyPair.publicKey,
      signatureType: 0,
    },
    partyB: {
      address: p.coreB.address,
      publicKey: p.coreB.keyPair.publicKey,
      signatureType: 0,
    },
    aAmount: stake,
    bAmount: stake,
    timeoutMs: 86_400_000n,
    penaltyAmount: 0n,
  }));

  const openTx = new Transaction();
  buildOpenAndFundMany(openTx, specs);
  const openRes = await client.signAndExecuteTransaction({
    signer: funder,
    transaction: openTx,
    options: { showObjectChanges: true, showEffects: true },
  });
  if (openRes.effects?.status?.status !== "success") {
    throw new Error(`create_and_fund failed: ${openRes.effects?.status?.error ?? "unknown"}`);
  }
  await client.waitForTransaction({ digest: openRes.digest });
  const tunnelIds = parseAllTunnelIds(openRes.objectChanges);
  if (tunnelIds.length !== tunnelCount) {
    throw new Error(`expected ${tunnelCount} tunnel ids, got ${tunnelIds.length}`);
  }

  // Read each tunnel's on-chain created_at for timestamp anchoring.
  const createdAts = await Promise.all(
    tunnelIds.map(async (id) => {
      const obj = await client.getObject({ id, options: { showContent: true } });
      const fields = (obj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
      return BigInt((fields?.created_at as string) ?? 0);
    })
  );

  // Register backend sessions concurrently.
  const sessionResults = await Promise.all(
    tunnelIds.map((tunnelId, i) =>
      controlPlane.registerSession({
        userAddress: pairs[i].coreA.address,
        game: gameId,
        tunnels: [{ tunnelId, partyA: pairs[i].coreA.address, partyB: pairs[i].coreB.address }],
      })
    )
  );

  return tunnelIds.map((tunnelId, i) => {
    const p = pairs[i];
    const bal: Balances = { a: stake, b: stake };
    const tunnel = OffchainTunnel.selfPlay(
      kit.protocol,
      tunnelId,
      p.coreA.keyPair,
      p.coreB.keyPair,
      p.coreA.address,
      p.coreB.address,
      bal,
      nativeBackend,
    );
    const transcript = new Transcript(tunnelId);
    tunnel.onUpdate = (u) => transcript.append(u);
    const ctx: BotContext = { rngForSeat: () => mulberry32(seed + i + 1) };
    return {
      tunnelId,
      createdAt: createdAts[i],
      tunnel,
      botA: kit.createBot("A", ctx),
      botB: kit.createBot("B", ctx),
      last: { A: null, B: null },
      transcript,
      sessionId: sessionResults[i].sessionId,
      statsToken: sessionResults[i].statsToken,
    };
  });
}

async function sendHeartbeat(slot: TunnelSlot, actionsDelta: number, windowMs: number): Promise<void> {
  try {
    await controlPlane.sendHeartbeat(slot.sessionId, slot.statsToken, {
      tunnelId: slot.tunnelId,
      nonce: String(slot.tunnel.latest?.update.nonce ?? 0),
      actionsDelta,
      windowMs,
    });
  } catch (e) {
    console.warn("[batch-lifecycle] heartbeat failed:", e);
  }
}

async function settleOne(slot: TunnelSlot): Promise<{ ok: boolean; digest?: string }> {
  const latest = slot.tunnel.latest;
  if (!latest) return { ok: false };
  try {
    const root = slot.transcript.root();
    const settlement = slot.tunnel.buildSettlementWithRoot(slot.createdAt, root, 0n);
    const body = coSignedToSettleBody(settlement, slot.transcript.rawEntries());
    const res = await controlPlane.settle(slot.tunnelId, body);
    return { ok: true, digest: res.txDigest };
  } catch (e) {
    console.warn(`[batch-lifecycle] settle failed for ${slot.tunnelId}:`, e);
    return { ok: false };
  }
}

async function main() {
  const funderKey = process.env.SUI_FUNDER_KEY;
  if (!funderKey) throw new Error("set SUI_FUNDER_KEY=<suiprivkey…>");
  const funder = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(funderKey).secretKey);

  console.log(`OPEN phase: ${tunnelCount} tunnels on ${network}`);
  const tOpen0 = Date.now();
  const slots = await openPhase(funder);
  const tOpen1 = Date.now();
  console.log(`OPEN done in ${((tOpen1 - tOpen0) / 1000).toFixed(1)}s`);

  console.log(`PLAY phase: ${durationMs}ms`);
  const heartbeatWindowMs = 1000;
  const actionsSinceHeartbeat = new Array(tunnelCount).fill(0);
  let heartbeatStart = Date.now();

  let steps = 0;
  const tPlay0 = Date.now();
  const deadline = tPlay0 + durationMs;
  const SEATS = ["A", "B"] as Party[];

  while (Date.now() < deadline) {
    for (let i = 0; i < tunnelCount; i++) {
      const slot = slots[i];
      if (kit.protocol.isTerminal(slot.tunnel.state)) continue;

      const state = slot.tunnel.state;
      const h = kit.stateHash(state);
      for (const seat of SEATS) {
        if (slot.last[seat] === h) continue;
        const bot = seat === "A" ? slot.botA : slot.botB;
        const move = bot.plan(state);
        if (move === null) continue;
        slot.tunnel.step(move, seat, { mode, timestamp: slot.createdAt });
        bot.confirm(state, move);
        slot.last[seat] = h;
        steps++;
        actionsSinceHeartbeat[i]++;
      }
    }

    const now = Date.now();
    if (now - heartbeatStart >= heartbeatWindowMs) {
      await Promise.all(
        slots.map((slot, i) =>
          sendHeartbeat(slot, actionsSinceHeartbeat[i], now - heartbeatStart)
        )
      );
      actionsSinceHeartbeat.fill(0);
      heartbeatStart = now;
    }
  }

  const tPlay1 = Date.now();
  const playDt = (tPlay1 - tPlay0) / 1000;
  console.log(`PLAY done: ${steps} steps in ${playDt.toFixed(1)}s -> STEPS_PER_S=${Math.round(steps / playDt)}`);

  // Final heartbeat flush.
  const finalWindow = Date.now() - heartbeatStart;
  await Promise.all(slots.map((slot, i) => sendHeartbeat(slot, actionsSinceHeartbeat[i], finalWindow)));

  console.log(`SETTLE phase: ${tunnelCount} tunnels`);
  const tSettle0 = Date.now();
  const settleResults = await Promise.all(slots.map(settleOne));
  const settledCount = settleResults.filter((r) => r.ok).length;
  const tSettle1 = Date.now();
  console.log(`SETTLE done in ${((tSettle1 - tSettle0) / 1000).toFixed(1)}s: ${settledCount}/${tunnelCount} succeeded`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
