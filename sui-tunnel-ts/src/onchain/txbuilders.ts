/**
 * Transaction builders for the CORE tunnel module (Deliverable 4).
 *
 * The on-chain safety net (cooperative close + the full dispute/timeout path) existed in
 * Move but was unreachable from the SDK — so no automated agent could recover funds from a
 * crashed counterparty. These builders close that gap: every `tunnel::entry_*` (and the
 * `withdraw_*` recovery functions) gets a typed PTB builder. They APPEND a Move call to a
 * caller-provided `Transaction` so several can be batched in one PTB.
 *
 * The clock is the shared `0x6` object; coin type defaults to SUI. Builders that consume a
 * latest off-chain artifact (CoSignedSettlement / CoSignedUpdate from core/tunnel.ts) wire
 * the bytes straight through, so settlement/dispute use exactly the signed state.
 */

import {
  Transaction,
  TransactionObjectArgument,
} from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { buildTarget, MODULES, RANDOM_ID, SUI_COIN_TYPE } from "../config";
import {
  CoSignedSettlement,
  CoSignedSettlementWithRoot,
  CoSignedUpdate,
} from "../core/tunnel";
import { Party } from "../protocol/Protocol";

const TUNNEL = MODULES.TUNNEL;
const SUI_RANDOMNESS = MODULES.SUI_RANDOMNESS;
const CLOCK = SUI_CLOCK_OBJECT_ID;

function vecU8(tx: Transaction, b: Uint8Array) {
  return tx.pure.vector("u8", Array.from(b));
}

/** A tunnel id passed either as a 0x-string or threaded from a prior PTB result. */
type TunnelIdArg = string | TransactionObjectArgument;

function tunnelIdArg(tx: Transaction, id: TunnelIdArg) {
  return typeof id === "string" ? tx.pure.id(id) : id;
}

export interface PartyArgs {
  address: string;
  publicKey: Uint8Array;
  signatureType: number;
}

export interface WithCoinType {
  coinType?: string;
}

/** create + share a tunnel (the shared object id is read from tx effects after execution). */
export function buildCreateAndShare(
  tx: Transaction,
  p: {
    partyA: PartyArgs;
    partyB: PartyArgs;
    timeoutMs: bigint;
    penaltyAmount: bigint;
  } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_create_and_share"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [
      tx.pure.address(p.partyA.address),
      vecU8(tx, p.partyA.publicKey),
      tx.pure.u8(p.partyA.signatureType),
      tx.pure.address(p.partyB.address),
      vecU8(tx, p.partyB.publicKey),
      tx.pure.u8(p.partyB.signatureType),
      tx.pure.u64(p.timeoutMs),
      tx.pure.u64(p.penaltyAmount),
      tx.object(CLOCK),
    ],
  });
}

/** Deposit an existing Coin<T> object/result into the tunnel. */
export function buildDeposit(
  tx: Transaction,
  p: { tunnelId: string; coin: TransactionObjectArgument } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_deposit"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [tx.object(p.tunnelId), p.coin, tx.object(CLOCK)],
  });
}

/** Split `amount` off the gas coin and deposit it (SUI tunnels only). */
export function buildDepositFromGas(
  tx: Transaction,
  p: { tunnelId: string; amount: bigint },
): void {
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(p.amount)]);
  buildDeposit(tx, { tunnelId: p.tunnelId, coin });
}

/**
 * Emit a Sui-native randomness seed for a Quantum Poker session. The event seed
 * is public entropy that a session can mix with private entropy before committing
 * poker slot secrets. Accepts a tunnel id threaded from a prior PTB result, so a
 * create-and-fund and the seed emission can compose in one transaction.
 */
export function buildEmitQuantumPokerRandomnessSeed(
  tx: Transaction,
  p: {
    tunnelId: TunnelIdArg;
    sessionNonce: bigint;
    context?: Uint8Array;
    randomObjectId?: string;
  },
): void {
  tx.moveCall({
    target: buildTarget(SUI_RANDOMNESS, "entry_emit_quantum_poker_seed"),
    arguments: [
      tx.object(p.randomObjectId ?? RANDOM_ID),
      tunnelIdArg(tx, p.tunnelId),
      tx.pure.u64(p.sessionNonce),
      vecU8(tx, p.context ?? new Uint8Array(0)),
    ],
  });
}

/** Cooperative close with both signatures over the settlement message. */
export function buildCloseCooperative(
  tx: Transaction,
  p: {
    tunnelId: string;
    partyABalance: bigint;
    partyBBalance: bigint;
    sigA: Uint8Array;
    sigB: Uint8Array;
    timestamp: bigint;
  } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_close_cooperative"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [
      tx.object(p.tunnelId),
      tx.pure.u64(p.partyABalance),
      tx.pure.u64(p.partyBBalance),
      vecU8(tx, p.sigA),
      vecU8(tx, p.sigB),
      tx.pure.u64(p.timestamp),
      tx.object(CLOCK),
    ],
  });
}

/** Cooperative close directly from a CoSignedSettlement produced by the off-chain engine. */
export function buildCloseFromSettlement(
  tx: Transaction,
  tunnelId: string,
  s: CoSignedSettlement,
  coinType?: string,
): void {
  buildCloseCooperative(tx, {
    tunnelId,
    partyABalance: s.settlement.partyABalance,
    partyBBalance: s.settlement.partyBBalance,
    sigA: s.sigA,
    sigB: s.sigB,
    timestamp: s.settlement.timestamp,
    coinType,
  });
}

/** Cooperative close that anchors a 32-byte transcript root (Deliverable 7/8). */
export function buildCloseCooperativeWithRoot(
  tx: Transaction,
  p: {
    tunnelId: string;
    partyABalance: bigint;
    partyBBalance: bigint;
    sigA: Uint8Array;
    sigB: Uint8Array;
    timestamp: bigint;
    transcriptRoot: Uint8Array;
  } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_close_cooperative_with_root"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [
      tx.object(p.tunnelId),
      tx.pure.u64(p.partyABalance),
      tx.pure.u64(p.partyBBalance),
      vecU8(tx, p.sigA),
      vecU8(tx, p.sigB),
      tx.pure.u64(p.timestamp),
      vecU8(tx, p.transcriptRoot),
      tx.object(CLOCK),
    ],
  });
}

/** Root-anchored close directly from the engine's CoSignedSettlementWithRoot. */
export function buildCloseWithRootFromSettlement(
  tx: Transaction,
  tunnelId: string,
  s: CoSignedSettlementWithRoot,
  coinType?: string,
): void {
  buildCloseCooperativeWithRoot(tx, {
    tunnelId,
    partyABalance: s.settlement.partyABalance,
    partyBBalance: s.settlement.partyBBalance,
    sigA: s.sigA,
    sigB: s.sigB,
    timestamp: s.settlement.timestamp,
    transcriptRoot: s.settlement.transcriptRoot,
    coinType,
  });
}

/**
 * Batch-settle many tunnels in ONE transaction by appending a close call per tunnel.
 * (A PTB can call close once per shared object — no on-chain loop is needed; this is the
 * SDK side of "settle N tunnels in one tx".) Returns the number of closes added.
 */
export function buildBatchClose(
  tx: Transaction,
  closes: { tunnelId: string; settlement: CoSignedSettlement }[],
  coinType?: string,
): number {
  for (const c of closes) {
    buildCloseFromSettlement(tx, c.tunnelId, c.settlement, coinType);
  }
  return closes.length;
}

/** Raise a dispute with the counterparty's signature over the latest co-signed state. */
export function buildRaiseDispute(
  tx: Transaction,
  p: {
    tunnelId: string;
    stateHash: Uint8Array;
    nonce: bigint;
    partyABalance: bigint;
    partyBBalance: bigint;
    timestamp: bigint;
    otherPartySig: Uint8Array;
  } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_raise_dispute"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [
      tx.object(p.tunnelId),
      vecU8(tx, p.stateHash),
      tx.pure.u64(p.nonce),
      tx.pure.u64(p.partyABalance),
      tx.pure.u64(p.partyBBalance),
      tx.pure.u64(p.timestamp),
      vecU8(tx, p.otherPartySig),
      tx.object(CLOCK),
    ],
  });
}

/** Raise a dispute from a latest CoSignedUpdate; `raiser` selects the counterparty sig. */
export function buildRaiseDisputeFromUpdate(
  tx: Transaction,
  tunnelId: string,
  u: CoSignedUpdate,
  raiser: Party,
  coinType?: string,
): void {
  buildRaiseDispute(tx, {
    tunnelId,
    stateHash: u.update.stateHash,
    nonce: u.update.nonce,
    partyABalance: u.update.partyABalance,
    partyBBalance: u.update.partyBBalance,
    timestamp: u.update.timestamp,
    otherPartySig: raiser === "A" ? u.sigB : u.sigA,
    coinType,
  });
}

/** Dispute the current on-chain state (nonce 0 or re-dispute; no counterparty sig). */
export function buildRaiseDisputeCurrentState(
  tx: Transaction,
  p: { tunnelId: string } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_raise_dispute_current_state"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [tx.object(p.tunnelId), tx.object(CLOCK)],
  });
}

/**
 * Resolve an open dispute by submitting the latest DUAL-signed state, overriding a stale
 * dispute the counterparty raised. The state's nonce must be strictly newer than the
 * disputed on-chain nonce. Maps a CoSignedUpdate straight onto `entry_resolve_dispute`.
 */
export function buildResolveDispute(
  tx: Transaction,
  tunnelId: string,
  u: CoSignedUpdate,
  coinType?: string,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_resolve_dispute"),
    typeArguments: [coinType ?? SUI_COIN_TYPE],
    arguments: [
      tx.object(tunnelId),
      vecU8(tx, u.update.stateHash),
      tx.pure.u64(u.update.nonce),
      tx.pure.u64(u.update.partyABalance),
      tx.pure.u64(u.update.partyBBalance),
      tx.pure.u64(u.update.timestamp),
      vecU8(tx, u.sigA),
      vecU8(tx, u.sigB),
      tx.object(CLOCK),
    ],
  });
}

/** Finalize a dispute after the timeout window (only the raiser). */
export function buildForceClose(
  tx: Transaction,
  p: { tunnelId: string } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_force_close"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [tx.object(p.tunnelId), tx.object(CLOCK)],
  });
}

/** Non-raiser accepts the disputed balances immediately (skips the timeout). */
export function buildAgreeToDispute(
  tx: Transaction,
  p: { tunnelId: string } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_agree_to_dispute"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [tx.object(p.tunnelId), tx.object(CLOCK)],
  });
}

/** Optional on-chain checkpoint of a co-signed state (not used on the happy path). */
export function buildUpdateState(
  tx: Transaction,
  p: {
    tunnelId: string;
    stateHash: Uint8Array;
    nonce: bigint;
    partyABalance: bigint;
    partyBBalance: bigint;
    timestamp: bigint;
    sigA: Uint8Array;
    sigB: Uint8Array;
  } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_update_state"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [
      tx.object(p.tunnelId),
      vecU8(tx, p.stateHash),
      tx.pure.u64(p.nonce),
      tx.pure.u64(p.partyABalance),
      tx.pure.u64(p.partyBBalance),
      tx.pure.u64(p.timestamp),
      vecU8(tx, p.sigA),
      vecU8(tx, p.sigB),
      tx.object(CLOCK),
    ],
  });
}

/** Recover own deposit before activation if the counterparty never deposited. */
export function buildWithdrawBeforeActive(
  tx: Transaction,
  p: { tunnelId: string; recipient: string } & WithCoinType,
): void {
  const coin = tx.moveCall({
    target: buildTarget(TUNNEL, "withdraw_before_active"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [tx.object(p.tunnelId), tx.object(CLOCK)],
  });
  tx.transferObjects([coin], tx.pure.address(p.recipient));
}

/** Recover own deposit after the timeout if the tunnel never activated. */
export function buildWithdrawTimeout(
  tx: Transaction,
  p: { tunnelId: string; recipient: string } & WithCoinType,
): void {
  const coin = tx.moveCall({
    target: buildTarget(TUNNEL, "withdraw_timeout"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [tx.object(p.tunnelId), tx.object(CLOCK)],
  });
  tx.transferObjects([coin], tx.pure.address(p.recipient));
}

/** Attach a single external-referee address (only while CREATED). */
export function buildSetReferee(
  tx: Transaction,
  p: { tunnelId: string; referee: string } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_set_referee"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [tx.object(p.tunnelId), tx.pure.address(p.referee)],
  });
}

/** Referee resolves a dispute with a chosen split (only the stored referee EOA). */
export function buildResolveDisputeExternal(
  tx: Transaction,
  p: {
    tunnelId: string;
    partyABalance: bigint;
    partyBBalance: bigint;
  } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_resolve_dispute_external"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [
      tx.object(p.tunnelId),
      tx.pure.u64(p.partyABalance),
      tx.pure.u64(p.partyBBalance),
      tx.object(CLOCK),
    ],
  });
}

/** Extend the dispute timeout window. */
export function buildExtendTimeout(
  tx: Transaction,
  p: { tunnelId: string; additionalMs: bigint } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_extend_timeout"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [
      tx.object(p.tunnelId),
      tx.pure.u64(p.additionalMs),
      tx.object(CLOCK),
    ],
  });
}

/** Lock real funds into an in-tunnel HTLC (counterparty-signed). */
export function buildLockHtlc(
  tx: Transaction,
  p: {
    tunnelId: string;
    paymentHash: Uint8Array;
    amount: bigint;
    receiver: string;
    expiryMs: bigint;
    counterpartySig: Uint8Array;
  } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_lock_htlc"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [
      tx.object(p.tunnelId),
      vecU8(tx, p.paymentHash),
      tx.pure.u64(p.amount),
      tx.pure.address(p.receiver),
      tx.pure.u64(p.expiryMs),
      vecU8(tx, p.counterpartySig),
      tx.object(CLOCK),
    ],
  });
}

/** Claim an in-tunnel HTLC by revealing the preimage. */
export function buildClaimHtlc(
  tx: Transaction,
  p: {
    tunnelId: string;
    paymentHash: Uint8Array;
    preimage: Uint8Array;
  } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_claim_htlc"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [
      tx.object(p.tunnelId),
      vecU8(tx, p.paymentHash),
      vecU8(tx, p.preimage),
      tx.object(CLOCK),
    ],
  });
}

/** Expire (reclaim) an in-tunnel HTLC after its deadline. */
export function buildExpireHtlc(
  tx: Transaction,
  p: { tunnelId: string; paymentHash: Uint8Array } & WithCoinType,
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "entry_expire_htlc"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [
      tx.object(p.tunnelId),
      vecU8(tx, p.paymentHash),
      tx.object(CLOCK),
    ],
  });
}
