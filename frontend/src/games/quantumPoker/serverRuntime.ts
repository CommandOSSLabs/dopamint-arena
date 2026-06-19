import { bytesEqual, fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import {
  blake2b256,
  generateKeyPair,
  nobleBackend,
  type SignFn,
} from "sui-tunnel-ts/core/crypto";
import type { CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import type { StateUpdate } from "sui-tunnel-ts/core/wire";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  type PokerState,
  QuantumPokerProtocol,
} from "sui-tunnel-ts/protocol/quantumPoker";
import {
  pokerMoveFromJson,
  pokerMoveToJson,
} from "sui-tunnel-ts/protocol/quantumPokerCodec";
import {
  JULES_PROFILE,
  NARI_PROFILE,
  QuantumPokerPersonaDriver,
} from "sui-tunnel-ts/protocol/quantumPokerPersona";
import {
  QuantumPokerServerClient,
  type CoSignedUpdateJson,
  type MovePrepareResponse,
  type SettleCommitResponse,
} from "./serverClient";
import type {
  QuantumPokerRuntimeSnapshot,
  QuantumPokerRuntimeStep,
} from "./runtime";

export type ServerRuntimeStatus =
  | "opening"
  | "active"
  | "settling"
  | "closed"
  | "error";

export interface ServerQuantumPokerRuntimeSnapshot
  extends QuantumPokerRuntimeSnapshot {
  mode: "server";
  status: ServerRuntimeStatus;
  sessionId: string;
  tunnelId: string;
  openTxDigest: string | null;
  closeTxDigest: string | null;
  transcriptRoot: string | null;
  transcriptUpdates: number;
  error: string | null;
}

const DEFAULT_STAKE = 5_000n;

function parseStateUpdate(json: CoSignedUpdateJson["update"]): StateUpdate {
  return {
    tunnelId: json.tunnelId,
    stateHash: fromHex(json.stateHash),
    nonce: BigInt(json.nonce),
    timestamp: BigInt(json.timestamp),
    partyABalance: BigInt(json.partyABalance),
    partyBBalance: BigInt(json.partyBBalance),
  };
}

function parseSignedUpdate(json: CoSignedUpdateJson): CoSignedUpdate {
  return {
    update: parseStateUpdate(json.update),
    sigA: fromHex(json.sigA),
    sigB: fromHex(json.sigB),
  };
}

function stateHash(protocol: QuantumPokerProtocol, state: PokerState): Uint8Array {
  return blake2b256(protocol.encodeState(state));
}

function messageBytes(hex: string): Uint8Array {
  return fromHex(hex);
}

function partyOrder(state: PokerState): Party[] {
  switch (state.phase) {
    case "preflop_bet":
    case "flop_bet":
    case "turn_bet":
    case "river_bet":
      return [state.toAct];
    case "done":
      return [];
    case "hand_over":
      return ["A"];
    default:
      return ["A", "B"];
  }
}

function seededRng(seed: number): () => number {
  let value = seed;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ServerQuantumPokerRuntime {
  readonly userParty: Party = "A";
  readonly botParty: Party = "B";

  private readonly protocol = new QuantumPokerProtocol(8n);
  private readonly userDriver = new QuantumPokerPersonaDriver(
    this.userParty,
    NARI_PROFILE,
  );
  private readonly signer: SignFn;
  private readonly rng: () => number;
  private latest: CoSignedUpdate | null = null;
  private status: ServerRuntimeStatus = "active";
  private closeTxDigest: string | null = null;
  private transcriptRoot: string | null = null;
  private transcriptUpdates = 0;
  private error: string | null = null;

  private constructor(
    private readonly client: QuantumPokerServerClient,
    private readonly sessionId: string,
    private readonly tunnelId: string,
    private state: PokerState,
    private nonce: bigint,
    private readonly openTxDigest: string | null,
    signer: SignFn,
    seed: number,
  ) {
    this.signer = signer;
    this.rng = seededRng(seed);
  }

  static async open(
    walletAddress: string,
    stake = DEFAULT_STAKE,
    client = new QuantumPokerServerClient(),
  ): Promise<ServerQuantumPokerRuntime> {
    const userKey = generateKeyPair();
    const session = await client.createSession({
      userAddress: walletAddress,
      userPublicKey: "0x" + toHex(userKey.publicKey),
      signatureType: userKey.scheme,
      stake: stake.toString(),
    });
    if (session.userParty !== "A" || session.botParty !== "B") {
      throw new Error("configured lane must be user A vs bot B");
    }

    const opened = await client.open(session.sessionId);
    const protocol = new QuantumPokerProtocol(8n);
    const lockedStake = BigInt(opened.stake);
    const state = protocol.initialState({
      tunnelId: opened.tunnelId,
      initialBalances: { a: lockedStake, b: lockedStake },
    });
    const seed = Number.parseInt(opened.tunnelId.slice(-8), 16) || Date.now();

    return new ServerQuantumPokerRuntime(
      client,
      session.sessionId,
      opened.tunnelId,
      state,
      0n,
      opened.txDigest ?? null,
      nobleBackend.makeSigner(userKey.secretKey),
      seed,
    );
  }

  snapshot(): ServerQuantumPokerRuntimeSnapshot {
    return {
      mode: "server",
      status: this.status,
      sessionId: this.sessionId,
      tunnelId: this.tunnelId,
      openTxDigest: this.openTxDigest,
      closeTxDigest: this.closeTxDigest,
      transcriptRoot: this.transcriptRoot,
      transcriptUpdates: this.transcriptUpdates,
      error: this.error,
      state: this.state,
      nonce: this.nonce,
      latest: this.latest,
      stateHash: stateHash(this.protocol, this.state),
      userHoles: this.userDriver.knownHoleCards(this.state),
      botHoles: null,
      seatA: NARI_PROFILE,
      seatB: JULES_PROFILE,
    };
  }

  async step(): Promise<QuantumPokerRuntimeStep | null> {
    if (this.status !== "active") return null;

    for (const by of partyOrder(this.state)) {
      const prepared = await this.prepare(by);
      if (!prepared) continue;
      const move = pokerMoveFromJson(prepared.move);
      const nextState = this.protocol.applyMove(this.state, move, by);
      const expectedHash = stateHash(this.protocol, nextState);
      const actualHash = fromHex(prepared.update.stateHash);
      if (!bytesEqual(expectedHash, actualHash)) {
        throw new Error("server state hash does not match local poker state");
      }

      const signature = this.signer(messageBytes(prepared.message));
      const committed = await this.client.commitMove({
        sessionId: this.sessionId,
        proposalId: prepared.proposalId,
        userSignature: "0x" + toHex(signature),
      });
      const latest = parseSignedUpdate(committed.signedUpdate);
      if (!bytesEqual(latest.update.stateHash, expectedHash)) {
        throw new Error("accepted update hash does not match prepared state");
      }
      this.state = nextState;
      this.nonce = BigInt(committed.nonce);
      this.latest = latest;
      this.transcriptUpdates += 1;
      return { by, move, nonce: this.nonce, latest };
    }

    return null;
  }

  async settle(): Promise<SettleCommitResponse | null> {
    if (this.status === "closed") return null;
    if (this.status !== "active") return null;
    if (this.state.phase !== "done") return null;

    this.status = "settling";
    try {
      const prepared = await this.client.prepareSettlement({
        sessionId: this.sessionId,
        timestamp: Date.now().toString(),
      });
      const signature = this.signer(messageBytes(prepared.message));
      const committed = await this.client.commitSettlement({
        sessionId: this.sessionId,
        proposalId: prepared.proposalId,
        userSignature: "0x" + toHex(signature),
      });
      this.status = "closed";
      this.closeTxDigest = committed.txDigest ?? null;
      this.transcriptRoot = committed.transcriptRoot;
      this.transcriptUpdates = committed.transcriptUpdates;
      return committed;
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async prepare(by: Party): Promise<MovePrepareResponse | null> {
    if (by === this.userParty) {
      const move = this.userDriver.chooseMove(this.state, this.rng);
      if (!move) return null;
      return this.client.prepareMove({
        sessionId: this.sessionId,
        by,
        move: pokerMoveToJson(move),
        timestamp: Date.now().toString(),
      });
    }

    return this.client.prepareMove({
      sessionId: this.sessionId,
      by,
      timestamp: Date.now().toString(),
    });
  }
}

export function createServerQuantumPokerRuntime(
  walletAddress: string,
): Promise<ServerQuantumPokerRuntime> {
  return ServerQuantumPokerRuntime.open(walletAddress);
}
