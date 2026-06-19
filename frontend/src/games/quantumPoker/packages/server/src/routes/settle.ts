import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { nobleBackend, verify } from "sui-tunnel-ts/core/crypto";
import {
  serializeSettlementWithRoot,
  type SettlementWithRoot,
} from "sui-tunnel-ts/core/wire";
import { createQuantumPokerProtocol } from "../services/quantumPokerBot";
import { gameCoinConfigured } from "../services/gameCoin";
import {
  coSignedSettlementToJson,
  settlementToJson,
  stateSummaryToJson,
} from "../services/pokerJson";
import { transcriptRootFor } from "../services/transcript";
import type { BotWallet, BotWalletPool } from "../services/botWalletPool";
import type {
  InMemorySessionStore,
  QuantumPokerSession,
} from "../services/sessionStore";
import type {
  CoSignedSettlementWithRoot,
  CoSignedUpdate,
} from "../services/tunnelTypes";
import { json, type Handler } from "../router";
import type { ServerConfig } from "../serverConfig";

const MODULE_TUNNEL = "tunnel";

interface SettleBody {
  sessionId?: string;
  proposalId?: string;
  userSignature?: string;
  timestamp?: string | number;
  onchainNonce?: string | number;
}

export interface SettleDeps {
  botWalletPool: BotWalletPool;
  sessionStore: InMemorySessionStore;
  config: ServerConfig;
}

interface ExecutionLike {
  digest?: unknown;
  effects?: {
    status?: {
      status?: unknown;
      error?: unknown;
    };
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function randomId(prefix: string): string {
  const uuid =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}-${uuid}`;
}

function packageConfigured(packageId: string): boolean {
  return packageId !== "" && packageId !== "0x0";
}

function parseBigInt(
  raw: string | number | undefined,
  fallback: bigint,
): bigint {
  return raw === undefined ? fallback : BigInt(raw);
}

function signatureFromHex(hex: string | undefined): Uint8Array | Response {
  if (!hex) return json({ error: "userSignature is required" }, 400);
  try {
    const signature = fromHex(hex);
    if (signature.length !== 64) {
      return json({ error: "userSignature must be 64 bytes" }, 400);
    }
    return signature;
  } catch (error) {
    return json({ error: messageFromError(error) }, 400);
  }
}

function target(packageId: string, module: string, fn: string): string {
  return `${packageId}::${module}::${fn}`;
}

function vecU8(tx: Transaction, bytes: Uint8Array) {
  return tx.pure.vector("u8", Array.from(bytes));
}

function botKeypair(wallet: BotWallet): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(wallet.keyPair.secretKey);
}

export function buildCloseTx(
  config: ServerConfig,
  settlement: CoSignedSettlementWithRoot,
  latestUpdate: CoSignedUpdate | null,
): Transaction {
  const tx = new Transaction();
  if (latestUpdate) {
    tx.moveCall({
      target: target(config.suiTunnelPackageId, MODULE_TUNNEL, "entry_update_state"),
      typeArguments: [config.gameCoinType],
      arguments: [
        tx.object(latestUpdate.update.tunnelId),
        vecU8(tx, latestUpdate.update.stateHash),
        tx.pure.u64(latestUpdate.update.nonce),
        tx.pure.u64(latestUpdate.update.partyABalance),
        tx.pure.u64(latestUpdate.update.partyBBalance),
        tx.pure.u64(latestUpdate.update.timestamp),
        vecU8(tx, latestUpdate.sigA),
        vecU8(tx, latestUpdate.sigB),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  }
  tx.moveCall({
    target: target(
      config.suiTunnelPackageId,
      MODULE_TUNNEL,
      "entry_close_cooperative_with_root",
    ),
    typeArguments: [config.gameCoinType],
    arguments: [
      tx.object(settlement.settlement.tunnelId),
      tx.pure.u64(settlement.settlement.partyABalance),
      tx.pure.u64(settlement.settlement.partyBBalance),
      vecU8(tx, settlement.sigA),
      vecU8(tx, settlement.sigB),
      tx.pure.u64(settlement.settlement.timestamp),
      vecU8(tx, settlement.settlement.transcriptRoot),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

function createSettlement(
  session: QuantumPokerSession,
  body: SettleBody,
): SettlementWithRoot {
  const protocol = createQuantumPokerProtocol();
  const balances = protocol.balances(session.state);
  const onchainNonce = parseBigInt(body.onchainNonce, 0n);
  return {
    tunnelId: session.tunnelId,
    partyABalance: balances.a,
    partyBBalance: balances.b,
    finalNonce: onchainNonce + 1n,
    timestamp: parseBigInt(body.timestamp, BigInt(Date.now())),
    transcriptRoot: transcriptRootFor(session.tunnelId, session.transcriptUpdates),
  };
}

function prepareSettlement(
  deps: SettleDeps,
  session: QuantumPokerSession,
  body: SettleBody,
): Response {
  if (session.status !== "active") {
    return json({ error: "session must be active before settlement" }, 409);
  }
  if (session.pendingSettlement) {
    return json(
      {
        error: "session already has a pending settlement proposal",
        proposalId: session.pendingSettlement.id,
      },
      409,
    );
  }

  const settlement = createSettlement(session, body);
  const message = serializeSettlementWithRoot(settlement);
  const proposal = {
    id: randomId("qps"),
    settlement,
    message,
    createdAt: new Date().toISOString(),
  };
  session.pendingSettlement = proposal;
  deps.sessionStore.update(session);

  return json({
    status: "signature_required",
    sessionId: session.id,
    proposalId: proposal.id,
    settlement: settlementToJson(settlement),
    message: "0x" + toHex(message),
    messageBytes: message.length,
    state: stateSummaryToJson(session.state),
    transcriptRoot: "0x" + toHex(settlement.transcriptRoot),
    transcriptUpdates: session.transcriptUpdates.length,
  });
}

async function commitSettlement(
  deps: SettleDeps,
  session: QuantumPokerSession,
  body: SettleBody,
): Promise<Response> {
  if (!packageConfigured(deps.config.suiTunnelPackageId)) {
    return json({ error: "SUI_TUNNEL_PACKAGE_ID is not configured" }, 400);
  }
  if (!gameCoinConfigured(deps.config.gameCoinType)) {
    return json(
      { error: "GAME_COIN_TYPE or COIN_TYPE is not configured" },
      400,
    );
  }
  const pending = session.pendingSettlement;
  if (!pending) return json({ error: "no pending settlement proposal" }, 409);
  if (body.proposalId !== pending.id) {
    return json({ error: "proposalId does not match pending settlement" }, 409);
  }

  const userSignature = signatureFromHex(body.userSignature);
  if (userSignature instanceof Response) return userSignature;
  if (
    !verify(userSignature, pending.message, fromHex(session.user.publicKey))
  ) {
    return json({ error: "userSignature is invalid" }, 400);
  }

  const wallet = deps.botWalletPool.get(session.botWalletId);
  if (!wallet) return json({ error: "bot wallet not found" }, 500);

  const botSignature = nobleBackend.makeSigner(wallet.keyPair.secretKey)(
    pending.message,
  );
  const signed: CoSignedSettlementWithRoot = {
    settlement: pending.settlement,
    sigA: session.userParty === "A" ? userSignature : botSignature,
    sigB: session.userParty === "B" ? userSignature : botSignature,
  };

  const client = new SuiJsonRpcClient({
    url: deps.config.suiNetwork,
    network: deps.config.suiNetworkName,
  });
  const checkpointNonce = parseBigInt(body.onchainNonce, 0n);
  const checkpointUpdate =
    checkpointNonce > 0n && session.latestUpdate?.update.nonce === checkpointNonce
      ? session.latestUpdate
      : null;
  const result = (await client.signAndExecuteTransaction({
    signer: botKeypair(wallet),
    transaction: buildCloseTx(deps.config, signed, checkpointUpdate),
    options: {
      showEffects: true,
    },
  })) as ExecutionLike;

  const status = result.effects?.status?.status;
  if (status && status !== "success") {
    return json(
      {
        error: result.effects?.status?.error ?? "settlement transaction failed",
      },
      502,
    );
  }

  session.pendingSettlement = null;
  session.latestSettlement = signed;
  session.status = "closed";
  deps.sessionStore.update(session);
  deps.botWalletPool.release(session.id);

  return json({
    status: "closed",
    sessionId: session.id,
    tunnelId: session.tunnelId,
    coinType: deps.config.gameCoinType,
    coinSymbol: deps.config.gameCoinSymbol,
    txDigest: asString(result.digest),
    settlement: coSignedSettlementToJson(signed),
    transcriptRoot: "0x" + toHex(signed.settlement.transcriptRoot),
    transcriptUpdates: session.transcriptUpdates.length,
  });
}

export function createSettleHandler(deps: SettleDeps): Handler {
  return async (request: Request) => {
    const body = (await request.json()) as SettleBody;
    if (!body.sessionId) return json({ error: "sessionId is required" }, 400);
    const session = deps.sessionStore.get(body.sessionId);
    if (!session) return json({ error: "session not found" }, 404);
    if (body.proposalId) return commitSettlement(deps, session, body);
    return prepareSettlement(deps, session, body);
  };
}
