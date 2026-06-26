/**
 * Full on-chain tunnel-lifecycle benchmark driver.
 *
 * Same single-threaded, duration-based shape as solo.ts, but runs the complete
 * lifecycle against a real Sui testnet deployment:
 *   1. Open a shared tunnel on-chain via `create_and_fund` (MTPS stakes).
 *   2. Register a session with the backend control plane.
 *   3. Run bots and accumulate a transcript of every co-signed update.
 *   4. Send coarse heartbeats to the backend session route (~every 1024 steps).
 *   5. When the game ends, build a co-signed root settlement off-chain.
 *   6. Submit that settlement to the backend `/settle` route so the backend can
 *      execute `close_cooperative_with_root` on-chain and archive the transcript.
 *
 * In this model the benchmark client performs all the off-chain work (moves,
 * signatures, transcript root), pays for on-chain open, and pushes the final
 * settlement to the backend for execution and stats aggregation.
 *
 * Required env:
 *   SUI_FUNDER_KEY        — base64 suiprivkey of a funded testnet account
 *   BACKEND_URL           — tunnel-manager ALB base URL (default http://localhost:8080)
 *   SUI_NETWORK           — "testnet" | "mainnet" | "localnet" (default "testnet")
 *   PACKAGE_ID            — deployed sui_tunnel package (testnet default from .env.example)
 *   MTPS_PACKAGE_ID       — MTPS package (testnet default)
 *   MTPS_FAUCET_ID        — MTPS faucet object (testnet default)
 *   MTPS_COIN_TYPE        — MTPS coin type (testnet default)
 *
 * Usage (one process): npx tsx src/bench/solo-full-tunnel.ts blackjack full 20000 <seed>
 * Fan out: launch one per core with distinct seeds, sum each STEPS_PER_S line.
 */
import { GAME_KITS, type BotContext, type GameId } from "@/agent/gameKit";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { OffchainTunnel, type SignMode } from "sui-tunnel-ts/core/tunnel";
import { ParticipantRegistry } from "sui-tunnel-ts/core/keys";
import { mulberry32 } from "sui-tunnel-ts/sim/rng";
import { nativeBackend } from "sui-tunnel-ts/core/crypto-native";
import type { Balances } from "sui-tunnel-ts/protocol/Protocol";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { Transaction } from "@mysten/sui/transactions";
import { SuiClient, getFullnodeUrl } from "@/shims/sui-client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import {
  buildOpenAndFundOneReturnless as sdkBuildOpenAndFundOneReturnless,
} from "sui-tunnel-ts/onchain/createAndFund";
import { createControlPlaneClient } from "@/backend/controlPlane";
import { coSignedToSettleBody } from "@/backend/settleRequest";

// The SDK pins an older @mysten/sui than the frontend; cast the builder so it accepts this
// app's Transaction at compile time. At runtime vite-node dedupes to one class.
const buildOpenAndFundOneReturnless = sdkBuildOpenAndFundOneReturnless as unknown as (
  tx: Transaction,
  spec: Parameters<typeof sdkBuildOpenAndFundOneReturnless>[1],
  opts?: Parameters<typeof sdkBuildOpenAndFundOneReturnless>[2],
) => void;

const gameId = (process.argv[2] as GameId) ?? "blackjack";
const mode = (process.argv[3] as SignMode) ?? "full";
const durationMs = Number(process.argv[4] ?? 20000);
const seed = Number(process.argv[5] ?? 1);

const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";
const network = (process.env.SUI_NETWORK as "testnet" | "mainnet" | "localnet") ?? "testnet";
const packageId = process.env.PACKAGE_ID ?? "0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b";
process.env.PACKAGE_ID ??= packageId;

const mtpsPackageId = process.env.MTPS_PACKAGE_ID ?? "0x62e31a8b5105c16c67936fe129e3db17e5977a8667a3464db583baa89c04272c";
const mtpsFaucetId = process.env.MTPS_FAUCET_ID ?? "0x65df0b7d94cd1ef65f15324d5917b46a01d1964bcaa27c313fd04fd1394b5c8a";
const mtpsCoinType = process.env.MTPS_COIN_TYPE ?? "0x62e31a8b5105c16c67936fe129e3db17e5977a8667a3464db583baa89c04272c::mtps::MTPS";

const controlPlane = createControlPlaneClient(backendUrl);
const rpcUrl =
  process.env.SUI_RPC_URL ??
  (network === "localnet" ? "http://127.0.0.1:9000" : "https://rpc.testnet.sui.io");
const client = new SuiClient({ url: rpcUrl, network });

const funderKey = process.env.SUI_FUNDER_KEY;
if (!funderKey) {
  console.error("set SUI_FUNDER_KEY=<suiprivkey…>");
  process.exit(1);
}
const funder = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(funderKey).secretKey);

const kit = GAME_KITS[gameId];
if (!kit) {
  console.error(`Unknown gameId: ${gameId}. Available: ${Object.keys(GAME_KITS).join(", ")}`);
  process.exit(1);
}
const registry = new ParticipantRegistry(mulberry32(seed));
let idx = 0;

interface ActiveSlot {
  tunnelId: string;
  createdAt: bigint;
  tunnel: OffchainTunnel<unknown, unknown>;
  botA: ReturnType<typeof kit.createBot>;
  botB: ReturnType<typeof kit.createBot>;
  last: Record<Party, string | null>;
  transcript: Transcript;
  sessionId: string;
  statsToken: string;
  actionsSinceHeartbeat: number;
  lastHeartbeatAt: number;
  settled: boolean;
}

function parseCreatedTunnelId(objectChanges: unknown): string | null {
  if (!Array.isArray(objectChanges)) return null;
  for (const c of objectChanges as Array<Record<string, unknown>>) {
    if (
      c.type === "created" &&
      typeof c.objectType === "string" &&
      c.objectType.includes("::tunnel::Tunnel<")
    ) {
      return c.objectId as string;
    }
  }
  return null;
}

async function ensureMtpsCoin(need: bigint): Promise<string> {
  const funderAddr = funder.getPublicKey().toSuiAddress();
  const coins = await client.getCoins({ owner: funderAddr, coinType: mtpsCoinType });
  const bigEnough = coins.data.find((c) => BigInt(c.balance) >= need);
  if (bigEnough) return bigEnough.coinObjectId;

  console.log(`[solo-full-tunnel] minting MTPS to funder (need ${need} raw)`);
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

async function open(): Promise<ActiveSlot> {
  const i = idx++;
  const a = registry.create(`s${seed}-${i}-a`);
  const b = registry.create(`s${seed}-${i}-b`);
  const stake = kit.defaultStake;

  console.log(`[solo-full-tunnel] opening tunnel #${i} with stake ${stake}...`);
  const sourceCoinId = await ensureMtpsCoin(stake * 2n);
  console.log(`[solo-full-tunnel] using MTPS coin ${sourceCoinId}`);

  const openTx = new Transaction();
  buildOpenAndFundOneReturnless(
    openTx,
    {
      partyA: {
        address: a.address,
        publicKey: a.keyPair.publicKey,
        signatureType: 0,
      },
      partyB: {
        address: b.address,
        publicKey: b.keyPair.publicKey,
        signatureType: 0,
      },
      aAmount: stake,
      bAmount: stake,
      timeoutMs: 86_400_000n,
      penaltyAmount: 0n,
    },
    { coinType: mtpsCoinType, sourceCoin: openTx.object(sourceCoinId) },
  );

  console.log("[solo-full-tunnel] signing and executing create_and_fund...");
  const openRes = await client.signAndExecuteTransaction({
    signer: funder,
    transaction: openTx,
    options: { showObjectChanges: true, showEffects: true },
  });
  console.log(`[solo-full-tunnel] open tx digest: ${openRes.digest}`);
  if (openRes.effects?.status?.status !== "success") {
    throw new Error(`create_and_fund failed: ${openRes.effects?.status?.error ?? "unknown"}`);
  }
  console.log("[solo-full-tunnel] waiting for transaction...");
  await client.waitForTransaction({ digest: openRes.digest });

  const tunnelId = parseCreatedTunnelId(openRes.objectChanges);
  if (!tunnelId) {
    throw new Error("create_and_fund did not return a tunnel id");
  }
  console.log(`[solo-full-tunnel] tunnel id: ${tunnelId}`);

  const obj = await client.getObject({ id: tunnelId, options: { showContent: true } });
  const fields = (obj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  const createdAt = BigInt((fields?.created_at as string) ?? 0);

  const bal: Balances = { a: stake, b: stake };
  const tunnel = OffchainTunnel.selfPlay(
    kit.protocol,
    tunnelId,
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    bal,
    nativeBackend,
  );

  const transcript = new Transcript(tunnelId);
  tunnel.onUpdate = (u) => transcript.append(u);

  const ctx: BotContext = { rngForSeat: () => mulberry32(seed + i + 1) };

  console.log("[solo-full-tunnel] registering backend session...");
  const { sessionId, statsToken } = await controlPlane.registerSession({
    userAddress: a.address,
    game: gameId,
    tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
  });
  console.log(`[solo-full-tunnel] session ${sessionId}`);

  return {
    tunnelId,
    createdAt,
    tunnel,
    botA: kit.createBot("A", ctx),
    botB: kit.createBot("B", ctx),
    last: { A: null, B: null },
    transcript,
    sessionId,
    statsToken,
    actionsSinceHeartbeat: 0,
    lastHeartbeatAt: Date.now(),
    settled: false,
  };
}

async function sendHeartbeat(slot: ActiveSlot): Promise<void> {
  if (slot.actionsSinceHeartbeat === 0) return;
  const now = Date.now();
  const windowMs = now - slot.lastHeartbeatAt;
  try {
    await controlPlane.sendHeartbeat(slot.sessionId, slot.statsToken, {
      tunnelId: slot.tunnelId,
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
  if (!latest || slot.settled) return;
  try {
    const root = slot.transcript.root();
    const settlement = slot.tunnel.buildSettlementWithRoot(slot.createdAt, root, 0n);
    const body = coSignedToSettleBody(settlement, slot.transcript.rawEntries());
    const res = await controlPlane.settle(slot.tunnelId, body);
    slot.settled = true;
    console.log(`[solo-full-tunnel] settled ${slot.tunnelId} -> ${res.txDigest}`);
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
      if (Date.now() >= deadline) break;
      slot = await open();
    }

    const state = slot.tunnel.state;
    const h = kit.stateHash(state);
    for (const seat of ["A", "B"] as Party[]) {
      if (slot.last[seat] === h) continue;
      const bot = seat === "A" ? slot.botA : slot.botB;
      const move = bot.plan(state);
      if (move === null) continue;
      slot.tunnel.step(move, seat, { mode, timestamp: slot.createdAt });
      bot.confirm(state, move);
      slot.last[seat] = h;
      steps++;
      slot.actionsSinceHeartbeat++;
    }

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
