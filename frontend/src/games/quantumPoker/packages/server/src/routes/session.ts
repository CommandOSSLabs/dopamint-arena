import { blake2b256 } from "sui-tunnel-ts/core/crypto";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { createQuantumPokerProtocol } from "../services/quantumPokerBot";
import type { BotWalletPool } from "../services/botWalletPool";
import type {
  InMemorySessionStore,
  PartyConfigJson,
} from "../services/sessionStore";
import { json, type Handler } from "../router";

interface CreateSessionBody {
  userAddress?: string;
  userPublicKey?: string;
  signatureType?: number;
  stake?: string | number;
}

export interface SessionDeps {
  botWalletPool: BotWalletPool;
  sessionStore: InMemorySessionStore;
  defaultStake: bigint;
}

function randomId(prefix: string): string {
  const uuid =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}-${uuid}`;
}

function mockTunnelId(sessionId: string): string {
  return "0x" + toHex(blake2b256(new TextEncoder().encode(sessionId)));
}

function parseStake(
  raw: string | number | undefined,
  fallback: bigint,
): bigint {
  if (raw === undefined) return fallback;
  return BigInt(raw);
}

function parseUser(body: CreateSessionBody): PartyConfigJson {
  if (!body.userAddress || !body.userPublicKey) {
    throw new Error("userAddress and userPublicKey are required");
  }
  return {
    address: body.userAddress,
    publicKey: body.userPublicKey,
    signatureType: body.signatureType ?? 0,
  };
}

export function createSessionHandler(deps: SessionDeps): Handler {
  return async (request: Request) => {
    const body = (await request.json()) as CreateSessionBody;
    const user = parseUser(body);
    const stake = parseStake(body.stake, deps.defaultStake);
    const sessionId = randomId("qp");
    const botWallet = deps.botWalletPool.lease(sessionId);
    const bot = deps.botWalletPool.partyConfig(botWallet);
    const tunnelId = mockTunnelId(sessionId);
    const protocol = createQuantumPokerProtocol();
    const state = protocol.initialState({
      tunnelId,
      initialBalances: { a: stake, b: stake },
    });
    const now = new Date().toISOString();
    const session = deps.sessionStore.create({
      id: sessionId,
      tunnelId,
      userParty: "A",
      botParty: "B",
      user,
      bot,
      botWalletId: botWallet.id,
      stake,
      state,
      nonce: 0n,
      latestUpdate: null,
      transcriptUpdates: [],
      pendingMove: null,
      pendingSettlement: null,
      latestSettlement: null,
      suiRandomness: null,
      status: "created",
      createdAt: now,
      updatedAt: now,
    });

    return json({
      sessionId: session.id,
      tunnelId: session.tunnelId,
      userParty: session.userParty,
      botParty: session.botParty,
      user: session.user,
      bot: session.bot,
      stake: session.stake.toString(),
      nonce: session.nonce.toString(),
      status: session.status,
      suiRandomness: null,
      botWalletsAvailable: deps.botWalletPool.availableCount(),
      note: "draft session; call /api/quantum-poker/open to create and fund the real Sui tunnel",
    });
  };
}
