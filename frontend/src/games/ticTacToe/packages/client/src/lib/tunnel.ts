import { Transaction } from "@mysten/sui/transactions";
import { core, onchain, protocols } from "sui-tunnel-ts";
import { encodeStateHash, buildStateUpdateMsg, buildSettlementMsg } from "@ttt/shared";

// Near-zero-stake game (stake 0): balances stay 1/1 throughout, the board is the only state.
export const proto = new protocols.TicTacToeProtocol(0n);

export function newGameKey() {
  return core.generateKeyPair();
}

export interface PartyInput {
  address: string;
  publicKey: Uint8Array;
}

// The SDK's onchain.* builders expect a Transaction from @mysten/sui@1.28.1 (the SDK's pin);
// the client uses @mysten/sui@1.45.2. The two Transaction classes are structurally
// incompatible (private fields), so cast ONLY at this builder boundary. The built bytes are
// identical — the cast is type-only. (Same pattern as CustomWallet's sign/build calls.)
type SdkTx = Parameters<typeof onchain.buildCreateAndShare>[0];

export function buildCreateAndShareTx(partyA: PartyInput, partyB: PartyInput): Transaction {
  const tx = new Transaction();
  onchain.buildCreateAndShare(tx as unknown as SdkTx, {
    partyA: { address: partyA.address, publicKey: partyA.publicKey, signatureType: core.SignatureScheme.ED25519 },
    partyB: { address: partyB.address, publicKey: partyB.publicKey, signatureType: core.SignatureScheme.ED25519 },
    timeoutMs: 86400000n,
    penaltyAmount: 0n,
  });
  return tx;
}

export function buildDepositTx(tunnelId: string): Transaction {
  const tx = new Transaction();
  onchain.buildDepositFromGas(tx as unknown as SdkTx, { tunnelId, amount: 1n });
  return tx;
}

// Checkpoint a co-signed off-chain state onto the on-chain StateCommitment via
// `entry_update_state`. Submitted just before the cooperative close so the on-chain `state`
// reflects the played-out final state (final state_hash/balances/nonce) instead of the empty
// opening. The dual signatures are the SAME ones the off-chain engine produced for this update.
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

export function buildSettleTx(
  tunnelId: string,
  sigA: Uint8Array,
  sigB: Uint8Array,
  _finalNonce: bigint,
  timestamp: bigint,
): Transaction {
  const tx = new Transaction();
  onchain.buildCloseCooperative(tx as unknown as SdkTx, {
    tunnelId,
    partyABalance: 1n,
    partyBBalance: 1n,
    sigA,
    sigB,
    timestamp,
  });
  return tx;
}

export { encodeStateHash, buildStateUpdateMsg, buildSettlementMsg, core };
export const parseTunnelId = onchain.parseTunnelId;
