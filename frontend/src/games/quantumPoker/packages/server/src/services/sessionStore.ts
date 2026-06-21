import type { SettlementWithRoot } from "sui-tunnel-ts/core/wire";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type {
  PokerMove,
  PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import type { BotPartyConfig } from "./botWalletPool";
import type { PreparedProtocolStep } from "./tunnelSigning";
import type { CoSignedSettlementWithRoot, CoSignedUpdate } from "./tunnelTypes";

export interface PartyConfigJson {
  address: string;
  publicKey: string;
  signatureType: number;
}

export interface PendingPokerMove {
  id: string;
  by: Party;
  move: PokerMove;
  prepared: PreparedProtocolStep<PokerState>;
  createdAt: string;
}

export interface SuiSessionRandomness {
  seed: Uint8Array;
  source: "sui_random";
  randomObjectId: string;
  txDigest?: string;
  eventSeq?: string;
}

export interface PendingSettlement {
  id: string;
  settlement: SettlementWithRoot;
  message: Uint8Array;
  createdAt: string;
}

export interface QuantumPokerSession {
  id: string;
  tunnelId: string;
  userParty: Party;
  botParty: Party;
  user: PartyConfigJson;
  bot: BotPartyConfig;
  botWalletId: string;
  stake: bigint;
  state: PokerState;
  nonce: bigint;
  latestUpdate: CoSignedUpdate | null;
  transcriptUpdates: CoSignedUpdate[];
  pendingMove: PendingPokerMove | null;
  pendingSettlement: PendingSettlement | null;
  latestSettlement: CoSignedSettlementWithRoot | null;
  suiRandomness: SuiSessionRandomness | null;
  status: "created" | "funding" | "active" | "settling" | "closed";
  createdAt: string;
  updatedAt: string;
}

export class InMemorySessionStore {
  private readonly sessions = new Map<string, QuantumPokerSession>();

  create(session: QuantumPokerSession): QuantumPokerSession {
    if (this.sessions.has(session.id)) {
      throw new Error(`duplicate session id ${session.id}`);
    }
    this.sessions.set(session.id, session);
    return session;
  }

  get(sessionId: string): QuantumPokerSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  update(session: QuantumPokerSession): QuantumPokerSession {
    if (!this.sessions.has(session.id)) {
      throw new Error(`unknown session id ${session.id}`);
    }
    session.updatedAt = new Date().toISOString();
    this.sessions.set(session.id, session);
    return session;
  }
}
