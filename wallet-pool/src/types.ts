import type { SealedEnvelope } from "./envelope";

export type Network = "mainnet" | "testnet";
export type CoinType = string; // e.g. "0x2::sui::SUI"
export type WalletRole = "master" | "member";

export interface WalletEntry {
  role: WalletRole;
  address: string;
  ordinal: number;
  label?: string;
  createdAt: number;
  enabled: boolean;
  useCount: number;
  lastUsedAt: number;
  lastFundedAt?: number;
  fundedAmounts?: Record<string, string>; // coinType -> base-10 MIST string
}

export interface PoolBlob {
  version: 1;
  walletPoolId: string;
  network: Network;
  label?: string;
  createdAt: number;
  coinTypes: CoinType[];
  crypto: SealedEnvelope;
  index: WalletEntry[];
}

/** Plaintext inside the AES-GCM payload. */
export interface SealedMembers {
  masterSecret: string; // base64 32-byte seed
  members: { ordinal: number; secret: string }[]; // base64 32-byte seed
}
