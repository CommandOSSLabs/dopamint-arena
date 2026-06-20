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
  submitCooperativeClose(args: { tunnelId: string; coSigned: unknown }): Promise<{ digest: string }>;
  closeOnTimeout(args: { tunnelId: string }): Promise<{ digest: string }>;
}
