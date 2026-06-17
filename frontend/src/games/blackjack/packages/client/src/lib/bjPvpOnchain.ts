process.env.PACKAGE_ID ??= import.meta.env.VITE_TUNNEL_PACKAGE_ID;

import { Transaction } from "@mysten/sui/transactions";
import { core, onchain } from "sui-tunnel-ts";

const SUI = "0x2::sui::SUI";
type SdkTx = Parameters<typeof onchain.buildCreateAndShare>[0];

export interface PvpParty {
  walletAddress: string;
  ephemeralPubkey: Uint8Array;
}

/** Open + share the tunnel (seat A pays the trivial create gas). penalty = stake. */
export function buildCreateAndShareTx(a: PvpParty, b: PvpParty, stake: bigint): Transaction {
  const tx = new Transaction();
  onchain.buildCreateAndShare(tx as unknown as SdkTx, {
    partyA: { address: a.walletAddress, publicKey: a.ephemeralPubkey, signatureType: core.SignatureScheme.ED25519 },
    partyB: { address: b.walletAddress, publicKey: b.ephemeralPubkey, signatureType: core.SignatureScheme.ED25519 },
    timeoutMs: 86_400_000n,
    penaltyAmount: stake,
  });
  return tx;
}

/** Fund this seat's stake from the wallet's gas coin (signed by the seat's own wallet). */
export function buildDepositTx(tunnelId: string, stake: bigint): Transaction {
  const tx = new Transaction();
  onchain.buildDepositFromGas(tx as unknown as SdkTx, { tunnelId, amount: stake });
  return tx;
}

/** Cooperative close from the dual-signed settlement (the engine's combineSettlement output). */
export function buildCloseTx(tunnelId: string, settlement: core.CoSignedSettlement): Transaction {
  const tx = new Transaction();
  onchain.buildCloseFromSettlement(tx as unknown as SdkTx, tunnelId, settlement, SUI);
  return tx;
}

export const parseTunnelId = onchain.parseTunnelId;
