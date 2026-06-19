import { core, protocols } from "sui-tunnel-ts";

/** blake2b256 of the protocol's canonical state encoding → 32-byte state hash. */
export function encodeStateHash(
  proto: protocols.TicTacToeProtocol,
  state: protocols.TicTacToeState,
): Uint8Array {
  return core.blake2b256(proto.encodeState(state));
}
/** state-update message for signing (near-zero stake: balances always 1/1). */
export function buildStateUpdateMsg(
  tunnelId: string,
  stateHash: Uint8Array,
  nonce: bigint,
): Uint8Array {
  return core.serializeStateUpdate({
    tunnelId,
    stateHash,
    nonce,
    timestamp: 0n,
    partyABalance: 1n,
    partyBBalance: 1n,
  });
}
/** settlement message for cooperative close. */
export function buildSettlementMsg(
  tunnelId: string,
  partyABalance: bigint,
  partyBBalance: bigint,
  finalNonce: bigint,
  timestamp: bigint,
): Uint8Array {
  return core.serializeSettlement({
    tunnelId,
    partyABalance,
    partyBBalance,
    finalNonce,
    timestamp,
  });
}
