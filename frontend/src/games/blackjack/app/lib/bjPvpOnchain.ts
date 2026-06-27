process.env.PACKAGE_ID ??= import.meta.env.VITE_TUNNEL_PACKAGE_ID;

import {
  redeemStakeFromBalance,
  type StakeFromBalance,
} from "@/onchain/tunnelTx";
import { Transaction } from "@mysten/sui/transactions";
import { core, onchain } from "sui-tunnel-ts";

const SUI = "0x2::sui::SUI";
type SdkTx = Parameters<typeof onchain.buildCreateAndShare>[0];

export interface PvpParty {
  walletAddress: string;
  ephemeralPubkey: Uint8Array;
}

/** Open + share the tunnel (seat A pays the trivial create gas). penalty = stake.
 *  `coinType` defaults to SUI; pass MTPS to open a token-staked tunnel. */
export function buildCreateAndShareTx(
  a: PvpParty,
  b: PvpParty,
  stake: bigint,
  coinType: string = SUI,
): Transaction {
  const tx = new Transaction();
  onchain.buildCreateAndShare(tx as unknown as SdkTx, {
    partyA: {
      address: a.walletAddress,
      publicKey: a.ephemeralPubkey,
      signatureType: core.SignatureScheme.ED25519,
    },
    partyB: {
      address: b.walletAddress,
      publicKey: b.ephemeralPubkey,
      signatureType: core.SignatureScheme.ED25519,
    },
    timeoutMs: 86_400_000n,
    penaltyAmount: stake,
    coinType,
  });
  return tx;
}

/** Fund this seat's stake. With `stakeCoinId` the stake is split off that user coin (the MTPS,
 *  gas-sponsored path — a sponsored tx has no gas coin); otherwise it splits off the wallet's gas
 *  coin (SUI fallback). `coinType` defaults to SUI. */
export function buildDepositTx(
  tunnelId: string,
  stake: bigint,
  opts: {
    coinType?: string;
    stakeCoinId?: string;
    stakeFromBalance?: StakeFromBalance;
  } = {},
): Transaction {
  const tx = new Transaction();
  if (opts.stakeFromBalance) {
    // ADR-0013: the withdrawal is exactly `stake`, so deposit it whole — no split, no remainder.
    const coin = redeemStakeFromBalance(tx, opts.stakeFromBalance);
    onchain.buildDeposit(tx as unknown as SdkTx, {
      tunnelId,
      coin,
      coinType: opts.coinType,
    });
  } else if (opts.stakeCoinId) {
    const [coin] = tx.splitCoins(tx.object(opts.stakeCoinId), [
      tx.pure.u64(stake),
    ]);
    onchain.buildDeposit(tx as unknown as SdkTx, {
      tunnelId,
      coin,
      coinType: opts.coinType,
    });
  } else {
    onchain.buildDepositFromGas(tx as unknown as SdkTx, {
      tunnelId,
      amount: stake,
    });
  }
  return tx;
}

/**
 * Checkpoint the latest co-signed state on-chain (`update_state`). Submitted right before a
 * cooperative close so the close binds to it: `close_cooperative_with_root` recomputes
 * `final_nonce = state.nonce + 1`, so advancing the on-chain nonce to the latest makes any stale
 * lower-nonce settlement unverifiable (M2). `coinType` defaults to SUI; pass MTPS for a token tunnel.
 */
export function buildUpdateStateTx(
  tunnelId: string,
  u: core.CoSignedUpdate,
  coinType: string = SUI,
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

/** Cooperative close from the dual-signed settlement (the engine's combineSettlement output). */
export function buildCloseTx(
  tunnelId: string,
  settlement: core.CoSignedSettlement,
  coinType: string = SUI,
): Transaction {
  const tx = new Transaction();
  onchain.buildCloseFromSettlement(
    tx as unknown as SdkTx,
    tunnelId,
    settlement,
    coinType,
  );
  return tx;
}

/** Root-anchored cooperative close from the dual-signed settlement with root. */
export function buildCloseWithRootTx(
  tunnelId: string,
  settlement: core.CoSignedSettlementWithRoot,
  coinType: string = SUI,
): Transaction {
  const tx = new Transaction();
  onchain.buildCloseWithRootFromSettlement(
    tx as unknown as SdkTx,
    tunnelId,
    settlement,
    coinType,
  );
  return tx;
}

export const parseTunnelId = onchain.parseTunnelId;
