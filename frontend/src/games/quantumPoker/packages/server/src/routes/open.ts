import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { createQuantumPokerProtocol } from "../services/quantumPokerBot";
import type { BotWallet, BotWalletPool } from "../services/botWalletPool";
import type {
  InMemorySessionStore,
  QuantumPokerSession,
} from "../services/sessionStore";
import { gameCoinConfigured, selectStakeCoins } from "../services/gameCoin";
import { stateSummaryToJson } from "../services/pokerJson";
import { json, type Handler } from "../router";
import type { ServerConfig } from "../serverConfig";

const RANDOM_OBJECT_ID = "0x8";
const MODULE_TUNNEL = "tunnel";
const MODULE_SUI_RANDOMNESS = "sui_randomness";

interface OpenBody {
  sessionId?: string;
  timeoutMs?: string | number;
  penaltyAmount?: string | number;
}

export interface OpenDeps {
  botWalletPool: BotWalletPool;
  sessionStore: InMemorySessionStore;
  config: ServerConfig;
}

interface ObjectChangeLike {
  type?: unknown;
  objectId?: unknown;
  objectType?: unknown;
}

interface EventLike {
  type?: unknown;
  parsedJson?: unknown;
}

interface ExecutionLike {
  digest?: unknown;
  effects?: {
    status?: {
      status?: unknown;
      error?: unknown;
    };
  };
  objectChanges?: unknown;
  events?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseBigInt(raw: string | number | undefined, fallback: bigint): bigint {
  return raw === undefined ? fallback : BigInt(raw);
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function target(packageId: string, module: string, fn: string): string {
  return `${packageId}::${module}::${fn}`;
}

function vecU8(tx: Transaction, bytes: Uint8Array) {
  return tx.pure.vector("u8", Array.from(bytes));
}

function packageConfigured(packageId: string): boolean {
  return packageId !== "" && packageId !== "0x0";
}

export async function buildOpenFundAndSeedTx(
  session: QuantumPokerSession,
  config: ServerConfig,
  client: SuiJsonRpcClient,
  wallet: BotWallet,
  timeoutMs: bigint,
  penaltyAmount: bigint,
): Promise<Transaction> {
  const tx = new Transaction();
  const { coinA, coinB } = await selectStakeCoins({
    client,
    tx,
    owner: wallet.address,
    coinType: config.gameCoinType,
    coinSymbol: config.gameCoinSymbol,
    stake: session.stake,
  });
  const tunnelId = tx.moveCall({
    target: target(config.suiTunnelPackageId, MODULE_TUNNEL, "create_and_fund"),
    typeArguments: [config.gameCoinType],
    arguments: [
      tx.pure.address(session.user.address),
      vecU8(tx, fromHex(session.user.publicKey)),
      tx.pure.u8(session.user.signatureType),
      tx.pure.address(session.bot.address),
      vecU8(tx, fromHex(session.bot.publicKey)),
      tx.pure.u8(session.bot.signatureType),
      coinA,
      coinB,
      tx.pure.u64(timeoutMs),
      tx.pure.u64(penaltyAmount),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  tx.moveCall({
    target: target(
      config.suiTunnelPackageId,
      MODULE_SUI_RANDOMNESS,
      "entry_emit_quantum_poker_seed",
    ),
    arguments: [
      tx.object(RANDOM_OBJECT_ID),
      tunnelId,
      tx.pure.u64(session.nonce),
      vecU8(tx, new TextEncoder().encode(session.id)),
    ],
  });
  return tx;
}

export function extractTunnelId(
  result: ExecutionLike,
  packageId: string,
): string | null {
  if (Array.isArray(result.objectChanges)) {
    for (const change of result.objectChanges as ObjectChangeLike[]) {
      const objectType = asString(change.objectType);
      const objectId = asString(change.objectId);
      if (
        objectId &&
        objectType?.includes(`${packageId}::${MODULE_TUNNEL}::Tunnel<`)
      ) {
        return objectId;
      }
    }
  }
  return extractRandomnessEvent(result, packageId)?.tunnelId ?? null;
}

function bytesFromParsed(value: unknown): Uint8Array | null {
  if (Array.isArray(value)) {
    if (value.every((item) => Number.isInteger(item))) {
      return Uint8Array.from(value as number[]);
    }
    return null;
  }
  if (typeof value !== "string") return null;
  try {
    return fromHex(value);
  } catch {
    try {
      const binary = atob(value);
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
      return null;
    }
  }
}

export function extractRandomnessEvent(
  result: ExecutionLike,
  packageId: string,
): { tunnelId: string | null; seed: Uint8Array } | null {
  if (!Array.isArray(result.events)) return null;
  for (const event of result.events as EventLike[]) {
    const type = asString(event.type);
    if (
      !type?.endsWith(
        `${packageId}::${MODULE_SUI_RANDOMNESS}::QuantumPokerRandomnessSeed`,
      )
    ) {
      continue;
    }
    if (!isRecord(event.parsedJson)) continue;
    const seed = bytesFromParsed(event.parsedJson.seed);
    if (!seed || seed.length !== 32) continue;
    return {
      tunnelId: asString(event.parsedJson.tunnel_id),
      seed,
    };
  }
  return null;
}

function botKeypair(wallet: BotWallet): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(wallet.keyPair.secretKey);
}

export function createOpenHandler(deps: OpenDeps): Handler {
  return async (request: Request) => {
    const body = (await request.json()) as OpenBody;
    if (!body.sessionId) return json({ error: "sessionId is required" }, 400);
    if (!packageConfigured(deps.config.suiTunnelPackageId)) {
      return json({ error: "SUI_TUNNEL_PACKAGE_ID is not configured" }, 400);
    }
    if (!gameCoinConfigured(deps.config.gameCoinType)) {
      return json({ error: "GAME_COIN_TYPE or COIN_TYPE is not configured" }, 400);
    }

    const session = deps.sessionStore.get(body.sessionId);
    if (!session) return json({ error: "session not found" }, 404);
    if (session.status === "active" && session.suiRandomness) {
      return json({
        status: session.status,
        sessionId: session.id,
        tunnelId: session.tunnelId,
        coinType: deps.config.gameCoinType,
        coinSymbol: deps.config.gameCoinSymbol,
        state: stateSummaryToJson(session.state),
        suiRandomness: {
          source: session.suiRandomness.source,
          seed: "0x" + toHex(session.suiRandomness.seed),
          txDigest: session.suiRandomness.txDigest,
          eventSeq: session.suiRandomness.eventSeq,
        },
      });
    }

    const wallet = deps.botWalletPool.get(session.botWalletId);
    if (!wallet) return json({ error: "bot wallet not found" }, 500);

    const client = new SuiJsonRpcClient({
      url: deps.config.suiNetwork,
      network: deps.config.suiNetworkName,
    });
    let tx: Transaction;
    try {
      tx = await buildOpenFundAndSeedTx(
        session,
        deps.config,
        client,
        wallet,
        parseBigInt(body.timeoutMs, deps.config.defaultTimeoutMs),
        parseBigInt(body.penaltyAmount, deps.config.defaultPenaltyAmount),
      );
    } catch (error) {
      return json({ error: messageFromError(error) }, 409);
    }
    const result = (await client.signAndExecuteTransaction({
      signer: botKeypair(wallet),
      transaction: tx,
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true,
      },
    })) as ExecutionLike;

    const status = result.effects?.status?.status;
    if (status && status !== "success") {
      return json(
        { error: result.effects?.status?.error ?? "open transaction failed" },
        502,
      );
    }

    const tunnelId = extractTunnelId(result, deps.config.suiTunnelPackageId);
    const randomness = extractRandomnessEvent(result, deps.config.suiTunnelPackageId);
    if (!tunnelId || !randomness) {
      return json(
        { error: "open transaction did not return tunnel id and randomness seed" },
        502,
      );
    }

    const protocol = createQuantumPokerProtocol();
    session.tunnelId = tunnelId;
    session.state = protocol.initialState({
      tunnelId,
      initialBalances: { a: session.stake, b: session.stake },
    });
    session.nonce = 0n;
    session.latestUpdate = null;
    session.transcriptUpdates = [];
    session.pendingMove = null;
    session.pendingSettlement = null;
    session.latestSettlement = null;
    session.status = "active";
    session.suiRandomness = {
      seed: randomness.seed,
      source: "sui_random",
      randomObjectId: RANDOM_OBJECT_ID,
      txDigest: asString(result.digest) ?? undefined,
    };
    deps.sessionStore.update(session);

    return json({
      status: "active",
      sessionId: session.id,
      tunnelId: session.tunnelId,
      txDigest: asString(result.digest),
      stake: session.stake.toString(),
      coinType: deps.config.gameCoinType,
      coinSymbol: deps.config.gameCoinSymbol,
      state: stateSummaryToJson(session.state),
      suiRandomness: {
        source: session.suiRandomness.source,
        seed: "0x" + toHex(session.suiRandomness.seed),
        txDigest: session.suiRandomness.txDigest,
      },
    });
  };
}
