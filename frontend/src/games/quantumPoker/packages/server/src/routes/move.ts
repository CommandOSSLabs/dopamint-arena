import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { nobleBackend } from "sui-tunnel-ts/core/crypto";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { PokerMove } from "sui-tunnel-ts/protocol/quantumPoker";
import { json, type Handler } from "../router";
import type { BotWallet, BotWalletPool } from "../services/botWalletPool";
import {
  coSignedUpdateToJson,
  pokerMoveFromJson,
  pokerMoveToJson,
  stateSummaryToJson,
  stateUpdateToJson,
} from "../services/pokerJson";
import {
  QuantumPokerBot,
  createQuantumPokerProtocol,
} from "../services/quantumPokerBot";
import { createSuiSeededBotRng } from "../services/suiRandomness";
import type {
  InMemorySessionStore,
  QuantumPokerSession,
} from "../services/sessionStore";
import {
  completePreparedStep,
  prepareProtocolStep,
  signPreparedStep,
  verifyPreparedStepSignature,
  type StateUpdateVerifier,
} from "../services/tunnelSigning";

interface MoveBody {
  sessionId?: string;
  by?: Party;
  move?: unknown;
  proposalId?: string;
  userSignature?: string;
  timestamp?: string | number;
}

export interface MoveDeps {
  botWalletPool: BotWalletPool;
  sessionStore: InMemorySessionStore;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function randomId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}-${uuid}`;
}

function parseTimestamp(raw: string | number | undefined): bigint {
  return raw === undefined ? BigInt(Date.now()) : BigInt(raw);
}

function parseParty(raw: unknown, fallback: Party): Party {
  if (raw === undefined) return fallback;
  if (raw === "A" || raw === "B") return raw;
  throw new Error("by must be A or B");
}

function requireSession(
  store: InMemorySessionStore,
  sessionId: string | undefined,
): QuantumPokerSession | Response {
  if (!sessionId) return json({ error: "sessionId is required" }, 400);
  const session = store.get(sessionId);
  if (!session) return json({ error: "session not found" }, 404);
  return session;
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

function userVerifier(session: QuantumPokerSession): StateUpdateVerifier {
  return {
    publicKey: fromHex(session.user.publicKey),
    scheme: session.user.signatureType,
  };
}

function botVerifier(wallet: BotWallet): StateUpdateVerifier {
  return {
    publicKey: wallet.keyPair.publicKey,
    scheme: wallet.keyPair.scheme,
  };
}

function partyVerifiers(
  session: QuantumPokerSession,
  wallet: BotWallet,
): { partyA: StateUpdateVerifier; partyB: StateUpdateVerifier } {
  const user = userVerifier(session);
  const bot = botVerifier(wallet);
  return {
    partyA: session.userParty === "A" ? user : bot,
    partyB: session.userParty === "B" ? user : bot,
  };
}

function chooseMove(
  session: QuantumPokerSession,
  body: MoveBody,
  by: Party,
  wallet: BotWallet | null,
  protocol = createQuantumPokerProtocol(),
): PokerMove | Response {
  if (by === session.userParty) {
    if (body.move === undefined) {
      return json({ error: "move is required for user moves" }, 400);
    }
    try {
      return pokerMoveFromJson(body.move);
    } catch (error) {
      return json({ error: messageFromError(error) }, 400);
    }
  }

  if (body.move !== undefined) {
    return json({ error: "bot moves are generated server-side" }, 400);
  }
  if (!wallet) return json({ error: "bot wallet not found" }, 500);
  if (!session.suiRandomness) {
    return json(
      {
        error: "bot move generation requires Sui randomness",
        next: "wire Sui Random object 0x8 during real tunnel open/deposit, then derive bot private slot secrets from that session seed",
      },
      501,
    );
  }
  const move = new QuantumPokerBot(
    protocol,
    createSuiSeededBotRng(session, wallet),
  ).chooseMove(session.state, by);
  if (!move) return json({ error: "bot has no legal move in current state" }, 409);
  return move;
}

function botWalletForMove(
  deps: MoveDeps,
  session: QuantumPokerSession,
  by: Party,
): BotWallet | null | Response {
  if (by !== session.botParty) return null;
  const wallet = deps.botWalletPool.get(session.botWalletId);
  if (!wallet) return json({ error: "bot wallet not found" }, 500);
  return wallet;
}

function prepareMove(
  deps: MoveDeps,
  session: QuantumPokerSession,
  body: MoveBody,
): Response {
  if (session.pendingMove) {
    return json(
      {
        error: "session already has a pending move proposal",
        proposalId: session.pendingMove.id,
      },
      409,
    );
  }

  let by: Party;
  try {
    by = parseParty(body.by, session.userParty);
  } catch (error) {
    return json({ error: messageFromError(error) }, 400);
  }

  const protocol = createQuantumPokerProtocol();
  const wallet = botWalletForMove(deps, session, by);
  if (wallet instanceof Response) return wallet;
  const move = chooseMove(session, body, by, wallet, protocol);
  if (move instanceof Response) return move;

  try {
    const prepared = prepareProtocolStep(protocol, session.state, move, by, {
      tunnelId: session.tunnelId,
      currentNonce: session.nonce,
      timestamp: parseTimestamp(body.timestamp),
      total: session.state.total,
    });
    const proposal = {
      id: randomId("qpm"),
      by,
      move,
      prepared,
      createdAt: new Date().toISOString(),
    };
    session.pendingMove = proposal;
    deps.sessionStore.update(session);

    return json({
      status: "signature_required",
      sessionId: session.id,
      proposalId: proposal.id,
      by,
      move: pokerMoveToJson(move),
      update: stateUpdateToJson(prepared.update),
      message: "0x" + toHex(prepared.message),
      messageBytes: prepared.messageBytes,
      nextState: stateSummaryToJson(prepared.nextState),
    });
  } catch (error) {
    return json({ error: messageFromError(error) }, 400);
  }
}

function commitMove(
  deps: MoveDeps,
  session: QuantumPokerSession,
  body: MoveBody,
): Response {
  const pending = session.pendingMove;
  if (!pending) return json({ error: "no pending move proposal" }, 409);
  if (body.proposalId !== pending.id) {
    return json({ error: "proposalId does not match pending move" }, 409);
  }

  const userSignature = signatureFromHex(body.userSignature);
  if (userSignature instanceof Response) return userSignature;

  const wallet = deps.botWalletPool.get(session.botWalletId);
  if (!wallet) return json({ error: "bot wallet not found" }, 500);

  let verifiedUser = false;
  try {
    verifiedUser = verifyPreparedStepSignature(
      pending.prepared,
      userSignature,
      userVerifier(session),
    );
  } catch (error) {
    return json({ error: messageFromError(error) }, 400);
  }
  if (!verifiedUser) return json({ error: "userSignature is invalid" }, 400);

  const botSignature = signPreparedStep(
    pending.prepared,
    nobleBackend.makeSigner(wallet.keyPair.secretKey),
  );
  const sigA = session.userParty === "A" ? userSignature : botSignature;
  const sigB = session.userParty === "B" ? userSignature : botSignature;
  const { partyA, partyB } = partyVerifiers(session, wallet);

  try {
    const completed = completePreparedStep(
      pending.prepared,
      sigA,
      sigB,
      partyA,
      partyB,
    );
    session.state = pending.prepared.nextState;
    session.nonce = pending.prepared.update.nonce;
    session.latestUpdate = completed.signed;
    session.pendingMove = null;
    session.status = session.status === "created" ? "active" : session.status;
    deps.sessionStore.update(session);

    return json({
      status: "accepted",
      sessionId: session.id,
      proposalId: pending.id,
      by: pending.by,
      move: pokerMoveToJson(pending.move),
      nonce: session.nonce.toString(),
      update: stateUpdateToJson(completed.signed.update),
      signedUpdate: coSignedUpdateToJson(completed.signed),
      verified: completed.verified,
      state: stateSummaryToJson(session.state),
    });
  } catch (error) {
    return json({ error: messageFromError(error) }, 400);
  }
}

export function createMoveHandler(deps: MoveDeps): Handler {
  return async (request: Request) => {
    const body = (await request.json()) as MoveBody;
    const session = requireSession(deps.sessionStore, body.sessionId);
    if (session instanceof Response) return session;
    if (body.proposalId) return commitMove(deps, session, body);
    return prepareMove(deps, session, body);
  };
}
