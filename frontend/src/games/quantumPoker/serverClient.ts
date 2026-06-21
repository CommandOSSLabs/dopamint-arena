import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { PokerMoveJson } from "sui-tunnel-ts/protocol/quantumPokerCodec";

export interface PartyConfigJson {
  address: string;
  publicKey: string;
  signatureType: number;
}

export interface StateUpdateJson {
  tunnelId: string;
  stateHash: string;
  nonce: string;
  timestamp: string;
  partyABalance: string;
  partyBBalance: string;
}

export interface CoSignedUpdateJson {
  update: StateUpdateJson;
  sigA: string;
  sigB: string;
}

export interface SettlementJson {
  tunnelId: string;
  partyABalance: string;
  partyBBalance: string;
  finalNonce: string;
  timestamp: string;
  transcriptRoot?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  tunnelId: string;
  userParty: Party;
  botParty: Party;
  user: PartyConfigJson;
  bot: PartyConfigJson;
  stake: string;
  nonce: string;
  status: string;
  botWalletsAvailable: number;
}

export interface OpenResponse {
  status: "active";
  sessionId: string;
  tunnelId: string;
  txDigest?: string;
  stake: string;
  coinType: string;
  coinSymbol: string;
  state: unknown;
  suiRandomness: {
    source: string;
    seed: string;
    txDigest?: string;
  };
}

export interface MovePrepareResponse {
  status: "signature_required";
  sessionId: string;
  proposalId: string;
  by: Party;
  move: PokerMoveJson;
  update: StateUpdateJson;
  message: string;
  messageBytes: number;
  nextState: unknown;
}

export interface MoveCommitResponse {
  status: "accepted";
  sessionId: string;
  proposalId: string;
  by: Party;
  move: PokerMoveJson;
  nonce: string;
  update: StateUpdateJson;
  signedUpdate: CoSignedUpdateJson;
  verified: boolean;
  state: unknown;
}

export interface SettlePrepareResponse {
  status: "signature_required";
  sessionId: string;
  proposalId: string;
  settlement: SettlementJson;
  message: string;
  messageBytes: number;
  state: unknown;
  transcriptRoot: string;
  transcriptUpdates: number;
}

export interface SettleCommitResponse {
  status: "closed";
  sessionId: string;
  tunnelId: string;
  coinType: string;
  coinSymbol: string;
  txDigest?: string;
  settlement: {
    settlement: SettlementJson;
    sigA: string;
    sigB: string;
  };
  transcriptRoot: string;
  transcriptUpdates: number;
}

export interface CreateSessionRequest {
  userAddress: string;
  userPublicKey: string;
  signatureType: number;
  stake?: string;
}

export interface MovePrepareRequest {
  sessionId: string;
  by: Party;
  move?: PokerMoveJson;
  timestamp?: string;
}

export interface MoveCommitRequest {
  sessionId: string;
  proposalId: string;
  userSignature: string;
}

export interface SettlePrepareRequest {
  sessionId: string;
  timestamp?: string;
}

export interface SettleCommitRequest {
  sessionId: string;
  proposalId: string;
  userSignature: string;
}

export function resolveQuantumPokerServerUrl(): string {
  return (
    import.meta.env.VITE_QUANTUM_POKER_SERVER_URL ?? "http://localhost:3002"
  ).replace(/\/$/, "");
}

export class QuantumPokerServerClient {
  constructor(private readonly baseUrl = resolveQuantumPokerServerUrl()) {}

  createSession(body: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.post("/api/quantum-poker/session", body);
  }

  open(sessionId: string): Promise<OpenResponse> {
    return this.post("/api/quantum-poker/open", { sessionId });
  }

  prepareMove(body: MovePrepareRequest): Promise<MovePrepareResponse> {
    return this.post("/api/quantum-poker/move", body);
  }

  commitMove(body: MoveCommitRequest): Promise<MoveCommitResponse> {
    return this.post("/api/quantum-poker/move", body);
  }

  prepareSettlement(
    body: SettlePrepareRequest,
  ): Promise<SettlePrepareResponse> {
    return this.post("/api/quantum-poker/settle", body);
  }

  commitSettlement(body: SettleCommitRequest): Promise<SettleCommitResponse> {
    return this.post("/api/quantum-poker/settle", body);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    if (!res.ok) {
      const message =
        typeof data?.error === "string"
          ? data.error
          : `${res.status} ${res.statusText}`;
      throw new Error(message);
    }
    return data as T;
  }
}
