// The SDK's onchain.* builders read the deployed package id from process.env.PACKAGE_ID;
// in the browser there's no process.env, so seed it from the Vite env before any builder runs.
process.env.PACKAGE_ID ??= import.meta.env.VITE_TUNNEL_PACKAGE_ID;

import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { core, onchain, protocols } from "sui-tunnel-ts";
import {
  consumeStakeRemainder,
  stakeCoinArg,
  type StakeFromBalance,
} from "@/onchain/tunnelTx";

export const proto = new protocols.BlackjackProtocol();

export interface PartyInput {
  address: string;
  publicKey: Uint8Array;
}

// The SDK's onchain.* builders expect a Transaction from @mysten/sui@1.28.1 (the SDK's pin);
// the client uses @mysten/sui@1.45.2. The two Transaction classes are structurally
// incompatible (private fields), so cast ONLY at this builder boundary. The built bytes are
// identical — the cast is type-only. (Same pattern as ticTacToe's tunnel.ts.)
type SdkTx = Parameters<typeof onchain.buildUpdateState>[0];

const PACKAGE_ID = import.meta.env.VITE_TUNNEL_PACKAGE_ID as string;

// Open + fund (both stakes) + activate the tunnel in ONE PTB via the framework's
// `tunnel::create_and_fund` extension. The single signer (the player bot) supplies BOTH stakes
// from its own gas coin, so the dealer bot signs nothing on-chain and the old 3-tx open
// (create_and_share + deposit A + deposit B) collapses to one signature; at cooperative close
// both stakes return to their parties by the co-signed final balances, so funder-pays-both is
// economically neutral (the stake is dust next to gas, and both keys are the user's own).
//
// Built as a raw moveCall (mirroring the SDK's onchain.buildCreateAndFund) rather than via the
// SDK helper, so it works regardless of whether this client's pinned SDK build exports it.
//
// `opts.stakeCoinId` splits BOTH stakes from that user/bot coin (DOPAMINT path); without it the
// stakes come from `tx.gas` (SUI fallback). CRITICAL: a sponsored tx has NO gas coin and the
// backend rejects any tx referencing `Gas`, so the DOPAMINT path MUST pass `stakeCoinId`.
export function buildCreateAndFundTx(
  partyA: PartyInput,
  partyB: PartyInput,
  stake: bigint,
  opts: {
    coinType?: string;
    stakeCoinId?: string;
    stakeFromBalance?: StakeFromBalance;
  } = {},
): Transaction {
  const tx = new Transaction();
  // ADR-0013: `stakeFromBalance` withdraws from the sender's address balance (no version-pinned
  // coin → no equivocation); else split off `stakeCoinId` (DOPAMINT coin) or `tx.gas` (SUI).
  const source = stakeCoinArg(tx, opts);
  const [coinA, coinB] = tx.splitCoins(source ?? tx.gas, [stake, stake]);
  tx.moveCall({
    target: `${PACKAGE_ID}::tunnel::create_and_fund`,
    typeArguments: [opts.coinType ?? "0x2::sui::SUI"],
    arguments: [
      tx.pure.address(partyA.address),
      tx.pure.vector("u8", Array.from(partyA.publicKey)),
      tx.pure.u8(core.SignatureScheme.ED25519),
      tx.pure.address(partyB.address),
      tx.pure.vector("u8", Array.from(partyB.publicKey)),
      tx.pure.u8(core.SignatureScheme.ED25519),
      coinA,
      coinB,
      tx.pure.u64(86_400_000n),
      tx.pure.u64(0n),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  // The split leaves the source coin; a redeemed Coin<T> has no `drop`, so destroy the zero
  // remainder (no-op on the coin-object / gas paths).
  consumeStakeRemainder(tx, opts, source);
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
  coinType: string = "0x2::sui::SUI",
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
    coinType,
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
  coinType: string = "0x2::sui::SUI",
): Transaction {
  const tx = new Transaction();
  onchain.buildCloseWithRootFromSettlement(
    tx as unknown as SdkTx,
    tunnelId,
    s,
    coinType,
  );
  return tx;
}

export const parseTunnelId = onchain.parseTunnelId;
export { core };
