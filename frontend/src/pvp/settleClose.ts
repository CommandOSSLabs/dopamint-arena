import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import type { CoSignedSettlementWithRoot } from "sui-tunnel-ts/core/tunnel";

/**
 * Co-sign the cooperative close over the PEER's transcript root.
 *
 * In the arena every match is human-vs-co-located-bot, and the bot owns the canonical transcript
 * (streamed to S3, `arena_anchor`). The FE keeps NO transcript of its own — it takes the root the bot
 * emitted in its settle half, signs seat A's half over that exact root, and combines. `combine`
 * re-verifies the peer's signature, so a forged/mismatched half can't produce a close. Funds are
 * unaffected: the chain pays the co-signed `balances` (from our own tunnel state) and only STORES the
 * root; anchoring the bot's root just makes the on-chain commitment match the S3 archive of record.
 *
 * `createdAt` is the on-chain `created_at` both seats sign as the settlement timestamp; nonce is fixed
 * at `onchainNonce = 0` (arena tunnels open fresh, close at nonce 1) exactly as the bot signs.
 */
export function coSignCloseFromPeerRoot<S, M>(
  dt: DistributedTunnel<S, M>,
  createdAt: bigint,
  peerRoot: Uint8Array,
  peerSig: Uint8Array,
): CoSignedSettlementWithRoot {
  const half = dt.buildSettlementHalfWithRoot(createdAt, peerRoot, 0n);
  return dt.combineSettlementWithRoot(half.settlement, half.sigSelf, peerSig);
}
