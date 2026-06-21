import type { Transport } from "sui-tunnel-ts/core/distributedTunnel";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

/** SDK Transport plus disconnect signals the fleet needs. */
export interface SessionTransport extends Transport {
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
  close(): void;
}

/** Produces the seat's signing endpoints once the opponent pubkey is known. */
export interface PartyEndpointFactory {
  /** This seat's endpoint: carries secretKey + bound sign. */
  self(): { publicKey: Uint8Array };
  /** Opaque self/opponent endpoints in the exact shape DistributedTunnel's cfg needs. */
  buildConfig(args: {
    tunnelId: string;
    selfParty: Party;
    opponentPublicKey: Uint8Array;
    opponentAddress: string;
  }): unknown;
}

/** On-chain seam — the only place a wallet / zkLogin is touched. */
export interface SettlementSigner {
  openAndFundSeatA(args: { stake: bigint }): Promise<{ tunnelId: string }>;
  depositSeatB(args: { tunnelId: string; stake: bigint }): Promise<void>;
  submitCooperativeClose(args: {
    tunnelId: string;
    coSigned: unknown;
  }): Promise<{ digest: string }>;
  closeOnTimeout(args: { tunnelId: string }): Promise<{ digest: string }>;
}

/** Settle-half payload exchanged over the app channel during cooperative close. */
export interface SettleHalf {
  /** Hex-encoded signature over the settlement-with-root message. */
  sig: string;
  /** Hex-encoded 32-byte transcript Merkle root this seat computed. */
  root: string;
}

/**
 * Per-match coordination channel returned by the relay for a specific matchId.
 * Carries the transport for the DistributedTunnel plus the four-way handshake
 * signals (partyHello/onPeerHello for pubkey exchange, announceOpened/onOpened
 * for seat A to broadcast the tunnelId to seat B), and the settle-half exchange
 * for cooperative close.
 */
export interface MatchChannel {
  /** The byte transport to thread into DistributedTunnel. */
  transport: SessionTransport;
  /** Broadcast this seat's ephemeral signing pubkey (hex). */
  partyHello(pubkeyHex: string): void;
  /** Fires once with the opponent's ephemeral pubkey (hex), buffering races. */
  onPeerHello(cb: (pubkeyHex: string) => void): void;
  /** Seat A: broadcast the on-chain tunnelId once the tunnel is created. */
  announceOpened(tunnelId: string): void;
  /** Seat B: fires once with the tunnelId broadcast by seat A, buffering races. */
  onOpened(cb: (tunnelId: string) => void): void;
  /** Send this seat's settlement half (sig + root) to the peer. */
  sendSettleHalf(half: SettleHalf): void;
  /** Register a one-shot callback for the peer's settlement half, buffering races. */
  onSettleHalf(cb: (half: SettleHalf) => void): void;
}

/**
 * Minimal relay capability the session needs for matchmaking and per-match
 * coordination.  The real adapter (over pvpRelay.ts / RelayClient) is Task 7;
 * tests inject a fake.
 */
export interface SessionRelay {
  /** Block until the relay connection is ready, then enqueue this seat for a match. */
  queueJoin(game: string): Promise<void>;
  /** Register a one-shot callback that fires when the matchmaker pairs us. */
  onMatch(cb: (match: MatchFound) => void): void;
  /** Return the app-channel for a given matchId. */
  channel(matchId: string): MatchChannel;
}

/** Match payload delivered by the matchmaker. */
export interface MatchFound {
  matchId: string;
  role: "A" | "B";
  opponentWallet: string;
}
