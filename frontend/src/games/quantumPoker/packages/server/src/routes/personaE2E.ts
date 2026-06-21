import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { blake2b256, nobleBackend } from "sui-tunnel-ts/core/crypto";
import { toHex } from "sui-tunnel-ts/core/bytes";
import {
  serializeSettlementWithRoot,
  type SettlementWithRoot,
} from "sui-tunnel-ts/core/wire";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type {
  PokerMove,
  PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import {
  JULES_PROFILE,
  NARI_PROFILE,
  QuantumPokerPersonaDriver,
  type QuantumPokerBotProfile,
} from "sui-tunnel-ts/protocol/quantumPokerPersona";
import {
  buildOpenFundAndSeedTx,
  extractRandomnessEvent,
  extractTunnelId,
} from "./open";
import { buildCloseTx } from "./settle";
import { json, type Handler } from "../router";
import type { ServerConfig } from "../serverConfig";
import type { BotWallet, BotWalletPool } from "../services/botWalletPool";
import { gameCoinConfigured } from "../services/gameCoin";
import { transcriptRootFor } from "../services/transcript";
import {
  coSignedSettlementToJson,
  coSignedUpdateToJson,
  pokerMoveToJson,
  settlementToJson,
  stateSummaryToJson,
} from "../services/pokerJson";
import { createQuantumPokerProtocol } from "../services/quantumPokerBot";
import { createSuiSeededBotRng } from "../services/suiRandomness";
import type {
  InMemorySessionStore,
  QuantumPokerSession,
} from "../services/sessionStore";
import type { CoSignedSettlementWithRoot } from "../services/tunnelTypes";
import {
  completePreparedStep,
  prepareProtocolStep,
  signPreparedStep,
  type StateUpdateVerifier,
} from "../services/tunnelSigning";

interface PersonaE2EBody {
  stake?: string | number;
  hands?: string | number;
  maxSteps?: string | number;
  settle?: boolean;
  timeoutMs?: string | number;
  penaltyAmount?: string | number;
  onchainNonce?: string | number;
}

interface PersonaE2EDeps {
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
  objectChanges?: unknown;
  events?: unknown;
}

interface DemoStep {
  step: number;
  by: Party;
  persona: string;
  phaseBefore: PokerState["phase"];
  phaseAfter: PokerState["phase"];
  handNo: string;
  nonce: string;
  move: ReturnType<typeof pokerMoveToJson>;
  state: ReturnType<typeof stateSummaryToJson>;
  signedUpdate: ReturnType<typeof coSignedUpdateToJson>;
}

class PersonaE2EError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

function randomId(prefix: string): string {
  const uuid =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}-${uuid}`;
}

function mockTunnelId(sessionId: string): string {
  return "0x" + toHex(blake2b256(new TextEncoder().encode(sessionId)));
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

function parseNumber(
  raw: string | number | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new PersonaE2EError(
      "hands and maxSteps must be positive integers",
      400,
    );
  }
  return value;
}

function botKeypair(wallet: BotWallet): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(wallet.keyPair.secretKey);
}

function verifier(wallet: BotWallet): StateUpdateVerifier {
  return {
    publicKey: wallet.keyPair.publicKey,
    scheme: wallet.keyPair.scheme,
  };
}

function profileForParty(
  by: Party,
  profileA: QuantumPokerBotProfile,
  profileB: QuantumPokerBotProfile,
): QuantumPokerBotProfile {
  return by === "A" ? profileA : profileB;
}

function chooseParties(state: PokerState): Party[] {
  switch (state.phase) {
    case "preflop_bet":
    case "flop_bet":
    case "turn_bet":
    case "river_bet":
      return [state.toAct];
    case "done":
      return [];
    default:
      return ["A", "B"];
  }
}

function chooseMove(
  state: PokerState,
  drivers: Record<Party, QuantumPokerPersonaDriver>,
  rngs: Record<Party, () => number>,
): { by: Party; move: PokerMove } | null {
  for (const by of chooseParties(state)) {
    const move = drivers[by].chooseMove(state, rngs[by]);
    if (move) return { by, move };
  }
  return null;
}

function completedHandCount(state: PokerState, seen: Set<string>): number {
  if (state.phase === "hand_over") seen.add(state.handNo.toString());
  return seen.size;
}

function assertConfigured(config: ServerConfig): void {
  if (!packageConfigured(config.suiTunnelPackageId)) {
    throw new PersonaE2EError("SUI_TUNNEL_PACKAGE_ID is not configured", 400);
  }
  if (!gameCoinConfigured(config.gameCoinType)) {
    throw new PersonaE2EError(
      "GAME_COIN_TYPE or COIN_TYPE is not configured",
      400,
    );
  }
}

function transactionDigest(result: ExecutionLike): string | undefined {
  return typeof result.digest === "string" ? result.digest : undefined;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeObjectVisibilityRace(message: string): boolean {
  return (
    message.includes("input objects are invalid") &&
    message.includes("does not exist")
  );
}

function assertTxSuccess(result: ExecutionLike, label: string): void {
  const status = result.effects?.status?.status;
  if (status && status !== "success") {
    const error = result.effects?.status?.error;
    throw new PersonaE2EError(
      typeof error === "string" ? error : `${label} transaction failed`,
      502,
    );
  }
}

async function waitForTransactionIfAvailable(
  client: SuiJsonRpcClient,
  digest: string | undefined,
): Promise<void> {
  if (!digest) return;
  await client.waitForTransaction({
    digest,
    timeout: 30_000,
    pollInterval: 1_000,
    options: { showEffects: true },
  });
}

function createSession(
  deps: PersonaE2EDeps,
  sessionId: string,
  walletA: BotWallet,
  walletB: BotWallet,
  stake: bigint,
): QuantumPokerSession {
  const protocol = createQuantumPokerProtocol();
  const tunnelId = mockTunnelId(sessionId);
  const now = new Date().toISOString();
  return deps.sessionStore.create({
    id: sessionId,
    tunnelId,
    userParty: "A",
    botParty: "B",
    user: deps.botWalletPool.partyConfig(walletA),
    bot: deps.botWalletPool.partyConfig(walletB),
    botWalletId: walletB.id,
    stake,
    state: protocol.initialState({
      tunnelId,
      initialBalances: { a: stake, b: stake },
    }),
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
}

async function openTunnel(
  deps: PersonaE2EDeps,
  client: SuiJsonRpcClient,
  session: QuantumPokerSession,
  walletB: BotWallet,
  body: PersonaE2EBody,
): Promise<string | undefined> {
  const tx = await buildOpenFundAndSeedTx(
    session,
    deps.config,
    client,
    walletB,
    parseBigInt(body.timeoutMs, deps.config.defaultTimeoutMs),
    parseBigInt(body.penaltyAmount, deps.config.defaultPenaltyAmount),
  );
  const result = (await client.signAndExecuteTransaction({
    signer: botKeypair(walletB),
    transaction: tx,
    options: {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  })) as ExecutionLike;
  assertTxSuccess(result, "open");

  const tunnelId = extractTunnelId(result, deps.config.suiTunnelPackageId);
  const randomness = extractRandomnessEvent(
    result,
    deps.config.suiTunnelPackageId,
  );
  if (!tunnelId || !randomness) {
    throw new PersonaE2EError(
      "open transaction did not return tunnel id and randomness seed",
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
    randomObjectId: "0x8",
    txDigest: transactionDigest(result),
  };
  deps.sessionStore.update(session);
  return transactionDigest(result);
}

function applyPersonaStep(
  deps: PersonaE2EDeps,
  session: QuantumPokerSession,
  walletA: BotWallet,
  walletB: BotWallet,
  stepNo: number,
  by: Party,
  move: PokerMove,
  profile: QuantumPokerBotProfile,
): DemoStep {
  const protocol = createQuantumPokerProtocol();
  const phaseBefore = session.state.phase;
  const prepared = prepareProtocolStep(protocol, session.state, move, by, {
    tunnelId: session.tunnelId,
    currentNonce: session.nonce,
    timestamp: BigInt(Date.now()),
    total: session.state.total,
  });
  const sigA = signPreparedStep(
    prepared,
    nobleBackend.makeSigner(walletA.keyPair.secretKey),
  );
  const sigB = signPreparedStep(
    prepared,
    nobleBackend.makeSigner(walletB.keyPair.secretKey),
  );
  const completed = completePreparedStep(
    prepared,
    sigA,
    sigB,
    verifier(walletA),
    verifier(walletB),
  );

  session.state = prepared.nextState;
  session.nonce = prepared.update.nonce;
  session.latestUpdate = completed.signed;
  session.transcriptUpdates.push(completed.signed);
  session.pendingMove = null;
  session.status = "active";
  deps.sessionStore.update(session);

  return {
    step: stepNo,
    by,
    persona: `${profile.name}/${profile.persona}`,
    phaseBefore,
    phaseAfter: session.state.phase,
    handNo: session.state.handNo.toString(),
    nonce: session.nonce.toString(),
    move: pokerMoveToJson(move),
    state: stateSummaryToJson(session.state),
    signedUpdate: coSignedUpdateToJson(completed.signed),
  };
}

async function closeTunnel(
  deps: PersonaE2EDeps,
  client: SuiJsonRpcClient,
  session: QuantumPokerSession,
  walletA: BotWallet,
  walletB: BotWallet,
  body: PersonaE2EBody,
): Promise<{ digest?: string; signed: CoSignedSettlementWithRoot }> {
  const protocol = createQuantumPokerProtocol();
  const balances = protocol.balances(session.state);
  const onchainNonce = parseBigInt(
    body.onchainNonce,
    session.latestUpdate?.update.nonce ?? 0n,
  );
  const settlement: SettlementWithRoot = {
    tunnelId: session.tunnelId,
    partyABalance: balances.a,
    partyBBalance: balances.b,
    finalNonce: onchainNonce + 1n,
    timestamp: BigInt(Date.now()),
    transcriptRoot: transcriptRootFor(
      session.tunnelId,
      session.transcriptUpdates,
    ),
  };
  const message = serializeSettlementWithRoot(settlement);
  const signed: CoSignedSettlementWithRoot = {
    settlement,
    sigA: nobleBackend.makeSigner(walletA.keyPair.secretKey)(message),
    sigB: nobleBackend.makeSigner(walletB.keyPair.secretKey)(message),
  };

  await waitForTransactionIfAvailable(client, session.suiRandomness?.txDigest);

  let result: ExecutionLike | null = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      result = (await client.signAndExecuteTransaction({
        signer: botKeypair(walletB),
        transaction: buildCloseTx(deps.config, signed, session.latestUpdate),
        options: {
          showEffects: true,
        },
      })) as ExecutionLike;
      break;
    } catch (error) {
      const message = messageFromError(error);
      if (attempt === 5 || !looksLikeObjectVisibilityRace(message)) {
        throw error;
      }
      await sleep(attempt * 1_000);
    }
  }
  if (!result) {
    throw new PersonaE2EError("settlement transaction was not submitted", 502);
  }
  assertTxSuccess(result, "settlement");

  session.pendingSettlement = null;
  session.latestSettlement = signed;
  session.status = "closed";
  deps.sessionStore.update(session);
  return { digest: transactionDigest(result), signed };
}

async function readBody(request: Request): Promise<PersonaE2EBody> {
  try {
    return (await request.json()) as PersonaE2EBody;
  } catch {
    return {};
  }
}

export function createPersonaE2EHandler(deps: PersonaE2EDeps): Handler {
  return async (request: Request) => {
    let sessionId = randomId("qp-e2e");
    const partyALeaseId = `${sessionId}:party-a`;
    let walletB: BotWallet | null = null;
    let walletA: BotWallet | null = null;

    try {
      const body = await readBody(request);
      assertConfigured(deps.config);
      if (deps.botWalletPool.availableCount() < 2) {
        throw new PersonaE2EError(
          "two available bot wallets are required",
          409,
        );
      }

      const stake = parseBigInt(body.stake, deps.config.defaultStake);
      const hands = parseNumber(body.hands, 1);
      const maxSteps = parseNumber(body.maxSteps, 500);
      const shouldSettle = body.settle ?? true;

      walletB = deps.botWalletPool.lease(sessionId);
      walletA = deps.botWalletPool.lease(partyALeaseId);

      const session = createSession(deps, sessionId, walletA, walletB, stake);
      const client = new SuiJsonRpcClient({
        url: deps.config.suiNetwork,
        network: deps.config.suiNetworkName,
      });
      const openTxDigest = await openTunnel(
        deps,
        client,
        session,
        walletB,
        body,
      );

      const profileA = NARI_PROFILE;
      const profileB = JULES_PROFILE;
      const drivers: Record<Party, QuantumPokerPersonaDriver> = {
        A: new QuantumPokerPersonaDriver("A", profileA),
        B: new QuantumPokerPersonaDriver("B", profileB),
      };
      const rngs: Record<Party, () => number> = {
        A: createSuiSeededBotRng(session, walletA),
        B: createSuiSeededBotRng(session, walletB),
      };
      const steps: DemoStep[] = [];
      const completedHands = new Set<string>();

      for (let step = 1; step <= maxSteps; step++) {
        if (completedHandCount(session.state, completedHands) >= hands) break;
        if (session.state.phase === "done") break;
        const selected = chooseMove(session.state, drivers, rngs);
        if (!selected) {
          throw new PersonaE2EError(
            `no persona move available in phase ${session.state.phase}`,
            409,
          );
        }
        const profile = profileForParty(selected.by, profileA, profileB);
        steps.push(
          applyPersonaStep(
            deps,
            session,
            walletA,
            walletB,
            step,
            selected.by,
            selected.move,
            profile,
          ),
        );
      }

      if (completedHandCount(session.state, completedHands) < hands) {
        throw new PersonaE2EError(
          `persona loop stopped before ${hands} hand(s); last phase=${session.state.phase}`,
          409,
        );
      }

      const settlement = shouldSettle
        ? await closeTunnel(deps, client, session, walletA, walletB, body)
        : null;

      return json({
        status: session.status,
        mode: "bot-vs-bot-onchain",
        sessionId: session.id,
        tunnelId: session.tunnelId,
        coinType: deps.config.gameCoinType,
        coinSymbol: deps.config.gameCoinSymbol,
        stake: session.stake.toString(),
        openTxDigest,
        settlementTxDigest: settlement?.digest,
        parties: {
          A: {
            walletId: walletA.id,
            address: walletA.address,
            profile: profileA,
          },
          B: {
            walletId: walletB.id,
            address: walletB.address,
            profile: profileB,
            role: "tunnel funder and gas payer",
          },
        },
        finalNonce: session.nonce.toString(),
        finalState: stateSummaryToJson(session.state),
        settlement: settlement
          ? coSignedSettlementToJson(settlement.signed)
          : session.latestSettlement
            ? coSignedSettlementToJson(session.latestSettlement)
            : null,
        settlementMessage: settlement
          ? settlementToJson(settlement.signed.settlement)
          : null,
        suiRandomness: session.suiRandomness
          ? {
              source: session.suiRandomness.source,
              seed: "0x" + toHex(session.suiRandomness.seed),
              txDigest: session.suiRandomness.txDigest,
            }
          : null,
        steps,
      });
    } catch (error) {
      const status = error instanceof PersonaE2EError ? error.status : 500;
      const message = error instanceof Error ? error.message : "unknown error";
      return json({ error: message, sessionId }, status);
    } finally {
      deps.botWalletPool.release(sessionId);
      deps.botWalletPool.release(partyALeaseId);
    }
  };
}
