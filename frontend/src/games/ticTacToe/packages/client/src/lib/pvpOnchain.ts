// frontend/src/games/ticTacToe/packages/client/src/lib/pvpOnchain.ts
import { Transaction } from "@mysten/sui/transactions";
import { core, onchain } from "sui-tunnel-ts";

const SUI = "0x2::sui::SUI";
// SDK builders are typed against the SDK's pinned @mysten/sui; the client uses a newer one. The
// built bytes are identical — cast only at this boundary (same pattern as lib/tunnel.ts).
type SdkTx = Parameters<typeof onchain.buildCreateAndShare>[0];

export interface PvpParty {
  walletAddress: string;
  publicKey: Uint8Array;
}

/** Open + share the tunnel registering both parties (the opener pays the trivial create gas). */
export function buildCreateAndShareTx(a: PvpParty, b: PvpParty, penaltyAmount: bigint): Transaction {
  const tx = new Transaction();
  onchain.buildCreateAndShare(tx as unknown as SdkTx, {
    partyA: { address: a.walletAddress, publicKey: a.publicKey, signatureType: core.SignatureScheme.ED25519 },
    partyB: { address: b.walletAddress, publicKey: b.publicKey, signatureType: core.SignatureScheme.ED25519 },
    timeoutMs: 86_400_000n,
    penaltyAmount,
  });
  return tx;
}

/** Fund this seat's bankroll from its own gas coin (signed by the seat's own keypair). */
export function buildDepositTx(tunnelId: string, amount: bigint): Transaction {
  const tx = new Transaction();
  onchain.buildDepositFromGas(tx as unknown as SdkTx, { tunnelId, amount });
  return tx;
}

/** Cooperative close from the dual-signed settlement (combineSettlement output). */
export function buildCloseTx(tunnelId: string, settlement: core.CoSignedSettlement): Transaction {
  const tx = new Transaction();
  onchain.buildCloseFromSettlement(tx as unknown as SdkTx, tunnelId, settlement, SUI);
  return tx;
}

export const parseTunnelId = onchain.parseTunnelId;
