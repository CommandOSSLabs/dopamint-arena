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

// Checkpoint the FINAL co-signed state on-chain (`entry_update_state`): writes the state field
// (nonce, final balances, state_hash) so the tunnel object reflects the played-out state — not
// the empty opening. Submitted right before the root close, so the object carries the final
// state_hash while the close event anchors the full-history transcript root. Requires the
// update's timestamp >= created_at (each step is signed with created_at; see the hooks).
export function buildUpdateStateTx(
  tunnelId: string,
  u: {
    update: {
      stateHash: Uint8Array;
      nonce: bigint;
      partyABalance: bigint;
      partyBBalance: bigint;
      timestamp: bigint;
    };
    sigA: Uint8Array;
    sigB: Uint8Array;
  },
): Transaction {
  const tx = new Transaction();
  onchain.buildUpdateState(tx as unknown as SdkTx, {
    tunnelId,
    stateHash: u.update.stateHash,
    nonce: u.update.nonce,
    partyABalance: u.update.partyABalance,
    partyBBalance: u.update.partyBBalance,
    timestamp: u.update.timestamp,
    sigA: u.sigA,
    sigB: u.sigB,
    coinType: "0x2::sui::SUI",
  });
  return tx;
}

// Close cooperatively AND anchor the off-chain transcript Merkle root in one tx
// (`entry_close_cooperative_with_root`): distributes funds by the co-signed final balances and
// commits the 32-byte root over EVERY co-signed update, compressing the full play history to a
// single on-chain commitment. The dual signatures are over the settlement-with-root message.
// Submitted after `update_state`, so both the final state_hash (object field) and the full
// transcript root (close event) end up on-chain.
export function buildSettleWithRootTx(
  tunnelId: string,
  s: core.CoSignedSettlementWithRoot,
): Transaction {
  const tx = new Transaction();
  onchain.buildCloseWithRootFromSettlement(tx as unknown as SdkTx, tunnelId, s, "0x2::sui::SUI");
  return tx;
}

export const parseTunnelId = onchain.parseTunnelId;
export { core };
