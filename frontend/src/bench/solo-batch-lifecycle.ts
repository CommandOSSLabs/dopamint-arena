/**
 * Batch full-lifecycle benchmark driver tuned for high off-chain TPS.
 *
 * Three distinct phases:
 *   1. OPEN   — on-chain create_and_fund a pool of shared tunnels in one PTB.
 *   2. PLAY   — pure off-chain stepping across the pool at full speed (no backend awaits).
 *   3. SETTLE — co-sign root settlements for every tunnel and submit them to the backend.
 *
 * By pushing open and settle to the edges and keeping the middle phase purely off-chain,
 * this measures the effective throughput of the tunnel engine + bot kits.
 *
 * Required env:
 *   SUI_FUNDER_KEY        — base64 suiprivkey of a funded account (opens + stakes + gas)
 *   BACKEND_URL           — tunnel-manager ALB base URL (default http://localhost:8080)
 *   SUI_RPC_URL           — Optional. Defaults to https://rpc.testnet.sui.io.
 *   SUI_NETWORK           — "testnet" | "mainnet" | "localnet" (default "testnet")
 *   PACKAGE_ID            — deployed sui_tunnel package (testnet default)
 *   MTPS_PACKAGE_ID       — MTPS package (testnet default)
 *   MTPS_FAUCET_ID        — MTPS faucet object (testnet default)
 *   MTPS_COIN_TYPE        — MTPS coin type (testnet default)
 *
 * Usage:
 *   npx vite-node --config vite.bench.config.ts src/bench/solo-batch-lifecycle.ts -- \
 *     <gameId> <mode> <durationMs> <tunnelCount> <seed> \
 *     [--skip-settle] [--sustain] [--duration=<n>[smh]]
 *
 * Flags:
 *   --skip-settle           Skip the on-chain settle/close phase.
 *   --sustain               When a tunnel reaches a terminal state, reset it off-chain and keep
 *                           playing the same on-chain tunnel. Use this to maintain TPS over a long
 *                           duration with terminating games like blackjack.
 *   --duration=<n>[smh]     Override the positional duration. e.g. --duration=30s, --duration=5m, --duration=1h
 */
import { GAME_KITS, type BotContext, type GameId } from "@/agent/gameKit";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { OffchainTunnel, type SignMode } from "sui-tunnel-ts/core/tunnel";
import { ParticipantRegistry } from "sui-tunnel-ts/core/keys";
import { mulberry32 } from "sui-tunnel-ts/sim/rng";
import { nativeBackend } from "sui-tunnel-ts/core/crypto-native";
import type { Balances } from "sui-tunnel-ts/protocol/Protocol";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import {
  buildOpenAndFundMany as sdkBuildOpenAndFundMany,
} from "sui-tunnel-ts/onchain/createAndFund";
import {
  buildCloseWithRootFromSettlement as sdkBuildCloseWithRootFromSettlement,
} from "sui-tunnel-ts/onchain/txbuilders";
import { Transaction } from "@mysten/sui/transactions";
import { SuiClient, getFullnodeUrl } from "@/shims/sui-client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { createControlPlaneClient } from "@/backend/controlPlane";
import { coSignedToSettleBody } from "@/backend/settleRequest";

function parseDuration(value: string): number {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([smh]?)$/i);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "s") return Math.round(n * 1000);
  if (unit === "m") return Math.round(n * 60 * 1000);
  if (unit === "h") return Math.round(n * 60 * 60 * 1000);
  return Math.round(n);
}

function parseArgs(argv: string[]) {
  const positionals: string[] = [];
  let skipSettle = false;
  let sustain = false;
  let durationOverride: number | undefined;

  for (const arg of argv) {
    if (arg === "--skip-settle") {
      skipSettle = true;
    } else if (arg === "--sustain") {
      sustain = true;
    } else if (arg.startsWith("--duration=")) {
      durationOverride = parseDuration(arg.slice("--duration=".length));
    } else if (arg === "--duration" || arg === "-d") {
      // Allow --duration <value> in next arg; handled by peeking would complicate loop.
      // We treat this as needing value in same arg; user can use --duration=...
      throw new Error("Use --duration=<value> with an equals sign");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return {
    gameId: (positionals[0] as GameId) ?? "blackjack",
    mode: (positionals[1] as SignMode) ?? "full",
    durationMs: durationOverride ?? Number(positionals[2] ?? 20000),
    tunnelCount: Number(positionals[3] ?? 50),
    seed: Number(positionals[4] ?? 1),
    skipSettle,
    sustain,
  };
}

const args = parseArgs(process.argv.slice(2));
const gameId = args.gameId;
const mode = args.mode;
const durationMs = args.durationMs;
const tunnelCount = args.tunnelCount;
const seed = args.seed;
const skipSettle = args.skipSettle;
const sustain = args.sustain;

const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";
const network = (process.env.SUI_NETWORK as "testnet" | "mainnet" | "localnet") ?? "testnet";
const rpcUrl =
  process.env.SUI_RPC_URL ??
  (network === "localnet" ? "http://127.0.0.1:9000" : "https://rpc.testnet.sui.io");
const packageId = process.env.PACKAGE_ID ?? "0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b";
process.env.PACKAGE_ID ??= packageId;

const mtpsPackageId =
  process.env.MTPS_PACKAGE_ID ??
  "0x62e31a8b5105c16c67936fe129e3db17e5977a8667a3464db583baa89c04272c";
const mtpsFaucetId =
  process.env.MTPS_FAUCET_ID ??
  "0x65df0b7d94cd1ef65f15324d5917b46a01d1964bcaa27c313fd04fd1394b5c8a";
const mtpsCoinType =
  process.env.MTPS_COIN_TYPE ??
  "0x62e31a8b5105c16c67936fe129e3db17e5977a8667a3464db583baa89c04272c::mtps::MTPS";

const controlPlane = createControlPlaneClient(backendUrl);
const client = new SuiClient({ url: rpcUrl, network });

const kit = GAME_KITS[gameId];
if (!kit) {
  console.error(`Unknown gameId: ${gameId}. Available: ${Object.keys(GAME_KITS).join(", ")}`);
  process.exit(1);
}
const registry = new ParticipantRegistry(mulberry32(seed));

// Cast SDK builders so they accept this app's @mysten/sui v2 Transaction class at compile time.
// At runtime vite-node dedupes @mysten/sui to one class.
const buildOpenAndFundMany = sdkBuildOpenAndFundMany as unknown as (
  tx: Transaction,
  specs: Parameters<typeof sdkBuildOpenAndFundMany>[1],
  opts?: Parameters<typeof sdkBuildOpenAndFundMany>[2],
) => void;
const buildCloseWithRootFromSettlement = sdkBuildCloseWithRootFromSettlement as unknown as (
  tx: Transaction,
  tunnelId: string,
  settlement: Parameters<typeof sdkBuildCloseWithRootFromSettlement>[2],
  coinType?: string,
) => void;

interface BotPair {
  coreA: ReturnType<typeof registry.create>;
  coreB: ReturnType<typeof registry.create>;
}

interface TunnelSlot {
  tunnelId: string;
  createdAt: bigint;
  coreA: ReturnType<typeof registry.create>;
  coreB: ReturnType<typeof registry.create>;
  tunnel: OffchainTunnel<unknown, unknown>;
  botA: ReturnType<typeof kit.createBot>;
  botB: ReturnType<typeof kit.createBot>;
  last: Record<Party, string | null>;
  transcript: Transcript;
  sessionId: string;
  statsToken: string;
  settled: boolean;
  /** Cumulative nonces from previous off-chain resets; keeps heartbeat nonce monotonic. */
  nonceOffset: bigint;
  /** How many times this tunnel has been reset in sustain mode. */
  resets: number;
}

function makeBotPair(index: number): BotPair {
  const coreA = registry.create(`s${seed}-${index}-a`);
  const coreB = registry.create(`s${seed}-${index}-b`);
  return { coreA, coreB };
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

async function ensureMtpsCoin(funder: Ed25519Keypair, need: bigint): Promise<string> {
  const funderAddr = funder.getPublicKey().toSuiAddress();
  const coins = await client.getCoins({ owner: funderAddr, coinType: mtpsCoinType });
  const bigEnough = coins.data.find((c) => BigInt(c.balance) >= need);
  if (bigEnough) return bigEnough.coinObjectId;

  console.log(`[batch-lifecycle] minting MTPS to funder (need ${need} raw)`);
  const tx = new Transaction();
  tx.moveCall({
    target: `${mtpsPackageId}::mtps::mint`,
    arguments: [tx.object(mtpsFaucetId), tx.pure.u64(need * 2n), tx.pure.address(funderAddr)],
  });
  const res = await client.signAndExecuteTransaction({
    signer: funder,
    transaction: tx,
    options: { showEffects: true },
  });
  if (res.effects?.status?.status !== "success") {
    throw new Error(`MTPS faucet failed: ${res.effects?.status?.error ?? "unknown"}`);
  }
  await client.waitForTransaction({ digest: res.digest });

  for (let i = 0; i < 10; i++) {
    const fresh = await client.getCoins({ owner: funderAddr, coinType: mtpsCoinType });
    const found = fresh.data.find((c) => BigInt(c.balance) >= need);
    if (found) return found.coinObjectId;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("MTPS faucet mint did not become indexable");
}

async function openPhase(funder: Ed25519Keypair): Promise<TunnelSlot[]> {
  const stake = kit.defaultStake;
  const totalStake = stake * BigInt(tunnelCount) * 2n;
  const sourceCoinId = await ensureMtpsCoin(funder, totalStake);

  const pairs: BotPair[] = [];
  for (let i = 0; i < tunnelCount; i++) pairs.push(makeBotPair(i));

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

  console.log(`[batch-lifecycle] opening ${tunnelCount} tunnels in one PTB...`);
  const openTx = new Transaction();
  buildOpenAndFundMany(openTx, specs, {
    coinType: mtpsCoinType,
    sourceCoin: openTx.object(sourceCoinId),
  });
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
  console.log(`[batch-lifecycle] open tx digest: ${openRes.digest}`);

  const createdAts = await Promise.all(
    tunnelIds.map(async (id) => {
      const obj = await client.getObject({ id, options: { showContent: true } });
      const fields = (obj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
      return BigInt((fields?.created_at as string) ?? 0);
    }),
  );

  console.log("[batch-lifecycle] registering backend sessions...");
  const sessionResults = await Promise.all(
    tunnelIds.map((tunnelId, i) =>
      controlPlane.registerSession({
        userAddress: pairs[i].coreA.address,
        game: gameId,
        tunnels: [{ tunnelId, partyA: pairs[i].coreA.address, partyB: pairs[i].coreB.address }],
      }),
    ),
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
      coreA: p.coreA,
      coreB: p.coreB,
      tunnel,
      botA: kit.createBot("A", ctx),
      botB: kit.createBot("B", ctx),
      last: { A: null, B: null },
      transcript,
      sessionId: sessionResults[i].sessionId,
      statsToken: sessionResults[i].statsToken,
      settled: false,
      nonceOffset: 0n,
      resets: 0,
    };
  });
}

function resetSlot(slot: TunnelSlot, index: number): void {
  // Preserve the cumulative nonce so the backend sees monotonic progression across resets.
  slot.nonceOffset += slot.tunnel.nonce;
  slot.resets++;

  const bal: Balances = { a: kit.defaultStake, b: kit.defaultStake };
  const tunnel = OffchainTunnel.selfPlay(
    kit.protocol,
    slot.tunnelId,
    slot.coreA.keyPair,
    slot.coreB.keyPair,
    slot.coreA.address,
    slot.coreB.address,
    bal,
    nativeBackend,
  );
  const transcript = new Transcript(slot.tunnelId);
  tunnel.onUpdate = (u) => transcript.append(u);

  // Vary the bot seed per reset so hands differ across lifetimes.
  const ctx: BotContext = { rngForSeat: () => mulberry32(seed + index + 1 + slot.resets) };

  slot.tunnel = tunnel as OffchainTunnel<unknown, unknown>;
  slot.transcript = transcript;
  slot.botA = kit.createBot("A", ctx);
  slot.botB = kit.createBot("B", ctx);
  slot.last = { A: null, B: null };
}

async function sendHeartbeat(
  slot: TunnelSlot,
  actionsDelta: number,
  windowMs: number,
): Promise<void> {
  if (actionsDelta === 0) return;
  try {
    const reportedNonce = (slot.tunnel.latest?.update.nonce ?? 0n) + slot.nonceOffset;
    await controlPlane.sendHeartbeat(slot.sessionId, slot.statsToken, {
      tunnelId: slot.tunnelId,
      nonce: String(reportedNonce),
      actionsDelta,
      windowMs,
    });
  } catch (e) {
    console.warn("[batch-lifecycle] heartbeat failed:", e);
  }
}

async function settleDirectOnChain(
  slot: TunnelSlot,
  funder: Ed25519Keypair,
): Promise<{ ok: boolean; digest?: string }> {
  const latest = slot.tunnel.latest;
  if (!latest) return { ok: false };
  try {
    const root = slot.transcript.root();
    const settlement = slot.tunnel.buildSettlementWithRoot(slot.createdAt, root, 0n);
    const tx = new Transaction();
    buildCloseWithRootFromSettlement(tx, slot.tunnelId, settlement, mtpsCoinType);
    const res = await client.signAndExecuteTransaction({
      signer: funder,
      transaction: tx,
      options: { showEffects: true },
    });
    if (res.effects?.status?.status !== "success") {
      throw new Error(res.effects?.status?.error ?? "direct close failed");
    }
    slot.settled = true;
    return { ok: true, digest: res.digest };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[batch-lifecycle] direct settle failed for ${slot.tunnelId}: ${msg}`);
    return { ok: false };
  }
}

async function settleOne(
  slot: TunnelSlot,
  funder: Ed25519Keypair,
): Promise<{ ok: boolean; digest?: string }> {
  const latest = slot.tunnel.latest;
  if (!latest || slot.settled) return { ok: false };

  try {
    const root = slot.transcript.root();
    const settlement = slot.tunnel.buildSettlementWithRoot(slot.createdAt, root, 0n);
    const body = coSignedToSettleBody(settlement, slot.transcript.rawEntries());
    const res = await controlPlane.settle(slot.tunnelId, body);
    slot.settled = true;
    return { ok: true, digest: res.txDigest };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[batch-lifecycle] backend settle failed for ${slot.tunnelId}: ${msg}`);
    return settleDirectOnChain(slot, funder);
  }
}

async function main() {
  const funderKey = process.env.SUI_FUNDER_KEY;
  if (!funderKey) {
    console.error("set SUI_FUNDER_KEY=<suiprivkey…>");
    process.exit(1);
  }
  const funder = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(funderKey).secretKey);

  console.log(`OPEN phase: ${tunnelCount} tunnels on ${network}`);
  const tOpen0 = Date.now();
  const slots = await openPhase(funder);
  const tOpen1 = Date.now();
  console.log(`OPEN done in ${((tOpen1 - tOpen0) / 1000).toFixed(1)}s`);

  console.log(`PLAY phase: ${durationMs}ms across ${tunnelCount} tunnels`);
  const heartbeatWindowMs = 1000;
  const actionsSinceHeartbeat = new Array(tunnelCount).fill(0);
  let heartbeatStart = Date.now();

  let steps = 0;
  const tPlay0 = Date.now();
  const deadline = tPlay0 + durationMs;
  const SEATS = ["A", "B"] as Party[];

  // Run each tunnel in its own async loop so a blocked/slow tunnel doesn't stall the others.
  // Atomic increments are safe because Node's event loop never interleaves synchronous JS.
  const tunnelLoops = slots.map(async (slot, i) => {
    let localSteps = 0;
    let localActions = 0;
    let lastYield = Date.now();

    while (Date.now() < deadline) {
      if (kit.protocol.isTerminal(slot.tunnel.state)) {
        if (sustain) {
          resetSlot(slot, i);
          continue;
        }
        // Yield briefly so terminal tunnels don't spin.
        await new Promise((r) => setImmediate(r));
        continue;
      }

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
        localSteps++;
        localActions++;
      }

      // Yield every ~16ms so other tunnels get CPU time.
      if (Date.now() - lastYield >= 16) {
        actionsSinceHeartbeat[i] += localActions;
        localActions = 0;
        await new Promise((r) => setImmediate(r));
        lastYield = Date.now();
      }
    }

    actionsSinceHeartbeat[i] += localActions;
    steps += localSteps;
  });

  // Heartbeat flusher runs in parallel with the play loops.
  const heartbeatLoop = (async () => {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, heartbeatWindowMs));
      const now = Date.now();
      await Promise.all(
        slots.map((slot, i) => sendHeartbeat(slot, actionsSinceHeartbeat[i], now - heartbeatStart)),
      );
      actionsSinceHeartbeat.fill(0);
      heartbeatStart = now;
    }
  })();

  await Promise.all([...tunnelLoops, heartbeatLoop]);

  const tPlay1 = Date.now();
  const playDt = (tPlay1 - tPlay0) / 1000;
  const totalResets = slots.reduce((sum, s) => sum + s.resets, 0);
  console.log(
    `PLAY done: ${steps} steps in ${playDt.toFixed(1)}s -> STEPS_PER_S=${Math.round(steps / playDt)}` +
      (sustain ? ` (resets=${totalResets})` : ""),
  );

  const finalWindow = Date.now() - heartbeatStart;
  await Promise.all(
    slots.map((slot, i) => sendHeartbeat(slot, actionsSinceHeartbeat[i], finalWindow)),
  );

  if (skipSettle) {
    console.log("SETTLE phase skipped (--skip-settle)");
  } else {
    console.log(`SETTLE phase: ${tunnelCount} tunnels`);
    const tSettle0 = Date.now();
    // Settle sequentially: the backend /settle route is flaky under concurrency (RPC-view skew),
    // and the settle phase is not the TPS target. Fall back to a direct on-chain close when the
    // backend rejects it.
    const settleResults: { ok: boolean; digest?: string }[] = [];
    for (const slot of slots) {
      settleResults.push(await settleOne(slot, funder));
    }
    const settledCount = settleResults.filter((r) => r.ok).length;
    const tSettle1 = Date.now();
    console.log(
      `SETTLE done in ${((tSettle1 - tSettle0) / 1000).toFixed(1)}s: ${settledCount}/${tunnelCount} succeeded`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
