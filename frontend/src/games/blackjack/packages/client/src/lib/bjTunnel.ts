// The SDK's onchain.* builders read the deployed package id from process.env.PACKAGE_ID;
// in the browser there's no process.env, so seed it from the Vite env before any builder runs.
process.env.PACKAGE_ID ??= import.meta.env.VITE_TUNNEL_PACKAGE_ID;

import { Transaction } from "@mysten/sui/transactions";
import { core, onchain, protocols } from "sui-tunnel-ts";

export const proto = new protocols.BlackjackProtocol();

export interface PartyInput {
  address: string;
  publicKey: Uint8Array;
}

// The SDK's onchain.* builders expect a Transaction from @mysten/sui@1.28.1 (the SDK's pin);
// the client uses @mysten/sui@1.45.2. The two Transaction classes are structurally
// incompatible (private fields), so cast ONLY at this builder boundary. The built bytes are
// identical — the cast is type-only. (Same pattern as ticTacToe's tunnel.ts.)
type SdkTx = Parameters<typeof onchain.buildCreateAndShare>[0];

export function buildCreateAndShareTx(partyA: PartyInput, partyB: PartyInput): Transaction {
  const tx = new Transaction();
  onchain.buildCreateAndShare(tx as unknown as SdkTx, {
    partyA: { address: partyA.address, publicKey: partyA.publicKey, signatureType: core.SignatureScheme.ED25519 },
    partyB: { address: partyB.address, publicKey: partyB.publicKey, signatureType: core.SignatureScheme.ED25519 },
    timeoutMs: 86_400_000n,
    penaltyAmount: 0n,
  });
  return tx;
}

export function buildDepositTx(tunnelId: string, amount: bigint): Transaction {
  const tx = new Transaction();
  onchain.buildDepositFromGas(tx as unknown as SdkTx, { tunnelId, amount });
  return tx;
}

// Blackjack balances VARY round to round, so close directly from the actual co-signed
// settlement (built by OffchainTunnel.buildSettlement) rather than hardcoded balances.
export function buildSettleTx(tunnelId: string, settlement: core.CoSignedSettlement): Transaction {
  const tx = new Transaction();
  onchain.buildCloseFromSettlement(tx as unknown as SdkTx, tunnelId, settlement, "0x2::sui::SUI");
  return tx;
}

export const parseTunnelId = onchain.parseTunnelId;
export { core };
