// On-chain tunnel lifecycle via the connected wallet, shared by both lanes:
//  - PvP (ADR-0004): `create_and_share` (address=wallet, public_key=ephemeral) + gated per-seat
//    deposits; cooperative close pays the winner.
//  - Self-play: one wallet funds BOTH ephemeral-bot seats via `create_and_fund` (one signature),
//    plays off-chain, then cooperative close moves the coins.
//
// The PTBs are assembled by the SDK's tx builders (single source of truth for the Move ABI).
// We build with THIS app's @mysten/sui Transaction (which dapp-kit signs); vite `dedupe` makes
// the SDK source resolve to the same @mysten/sui, so the builders append to our Transaction
// directly. The caller supplies sign+execute (dapp-kit) and a Sui client.
import { Transaction } from "@mysten/sui/transactions";
import {
  buildOpenAndFundSeatA as sdkOpenAndFundSeatA,
  buildOpenAndFundMany as sdkOpenAndFundMany,
  buildOpenAndFundOneReturnless as sdkOpenAndFundOneReturnless,
} from "sui-tunnel-ts/onchain/createAndFund";
import {
  buildDepositFromGas as sdkDepositFromGas,
  buildCloseFromSettlement as sdkCloseFromSettlement,
  buildCloseWithRootFromSettlement as sdkCloseWithRootFromSettlement,
  buildRaiseDisputeFromUpdate as sdkRaiseDisputeFromUpdate,
  buildForceClose as sdkForceClose,
} from "sui-tunnel-ts/onchain/txbuilders";
import { SignatureScheme } from "sui-tunnel-ts/core/crypto";
import type {
  CoSignedSettlement,
  CoSignedSettlementWithRoot,
  CoSignedUpdate,
} from "sui-tunnel-ts/core/tunnel";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

// The SDK tx builders are the single source of truth for the Move ABI. The SDK pins an older
// @mysten/sui, but vite `dedupe` makes these run against THIS app's Transaction at runtime; the
// casts bridge only the (nominal) compile-time Transaction-class difference — each builder's own
// argument types stay fully type-checked.
const buildOpenAndFundSeatA = sdkOpenAndFundSeatA as unknown as (
  tx: Transaction,
  p: Parameters<typeof sdkOpenAndFundSeatA>[1],
) => void;
const buildDepositFromGas = sdkDepositFromGas as unknown as (
  tx: Transaction,
  p: Parameters<typeof sdkDepositFromGas>[1],
) => void;
const buildCloseFromSettlement = sdkCloseFromSettlement as unknown as (
  tx: Transaction,
  tunnelId: string,
  settlement: Parameters<typeof sdkCloseFromSettlement>[2],
) => void;
const buildCloseWithRootFromSettlement =
  sdkCloseWithRootFromSettlement as unknown as (
    tx: Transaction,
    tunnelId: string,
    settlement: Parameters<typeof sdkCloseWithRootFromSettlement>[2],
  ) => void;
const buildOpenAndFundMany = sdkOpenAndFundMany as unknown as (
  tx: Transaction,
  specs: Parameters<typeof sdkOpenAndFundMany>[1],
) => void;
const buildRaiseDisputeFromUpdate = sdkRaiseDisputeFromUpdate as unknown as (
  tx: Transaction,
  tunnelId: string,
  u: CoSignedUpdate,
  raiser: Party,
) => void;
const buildForceClose = sdkForceClose as unknown as (
  tx: Transaction,
  p: { tunnelId: string },
) => void;
const buildOpenAndFundOneReturnless = sdkOpenAndFundOneReturnless as unknown as (
  tx: Transaction,
  spec: Parameters<typeof sdkOpenAndFundOneReturnless>[1],
) => void;

/** Sign + execute a transaction (e.g. dapp-kit's signAndExecuteTransaction). */
export type SignExec = (tx: Transaction) => Promise<{ digest: string }>;

/** Minimal read surface we need from a Sui client. */
export interface SuiReads {
  waitForTransaction(input: { digest: string }): Promise<unknown>;
  getTransactionBlock(input: {
    digest: string;
    options: { showObjectChanges: boolean };
  }): Promise<{ objectChanges?: unknown }>;
  getObject(input: {
    id: string;
    options: { showContent: boolean };
  }): Promise<{ data?: { content?: { fields?: Record<string, unknown> } } }>;
}

export interface PartyOnchain {
  address: string;
  publicKey: Uint8Array;
}

function findTunnelId(changes: unknown): string | null {
  if (!Array.isArray(changes)) return null;
  for (const c of changes) {
    if (
      c?.type === "created" &&
      typeof c.objectType === "string" &&
      c.objectType.includes("::tunnel::Tunnel")
    ) {
      return c.objectId as string;
    }
  }
  return null;
}

/**
 * Open the shared tunnel AND fund seat A's stake in ONE transaction (one wallet popup for the
 * host) via the SDK's `buildOpenAndFundSeatA`. Returns the shared object id from tx changes.
 * Seat B funds its own seat separately (`depositStake`).
 */
export async function openAndFundSharedTunnel(opts: {
  reads: SuiReads;
  signExec: SignExec;
  partyA: PartyOnchain;
  partyB: PartyOnchain;
  amount: bigint;
  timeoutMs?: bigint;
  penaltyAmount?: bigint;
}): Promise<string> {
  const tx = new Transaction();
  buildOpenAndFundSeatA(tx, {
    partyA: { ...opts.partyA, signatureType: SignatureScheme.ED25519 },
    partyB: { ...opts.partyB, signatureType: SignatureScheme.ED25519 },
    aAmount: opts.amount,
    timeoutMs: opts.timeoutMs ?? 86_400_000n,
    penaltyAmount: opts.penaltyAmount ?? 0n,
  });
  const { digest } = await opts.signExec(tx);
  await opts.reads.waitForTransaction({ digest });
  const txb = await opts.reads.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  });
  const tunnelId = findTunnelId(txb.objectChanges);
  if (!tunnelId) throw new Error("could not find created tunnel id");
  return tunnelId;
}

/**
 * Self-play: open + fund BOTH ephemeral-bot seats from the caller's gas in ONE tx (one wallet
 * signature) via the SDK's `buildOpenAndFundMany` (create_and_fund). Returns the shared object
 * id. The bots co-sign play off-chain; a later cooperative close moves the coins on-chain.
 */
export async function openAndFundSelfPlay(opts: {
  reads: SuiReads;
  signExec: SignExec;
  partyA: PartyOnchain;
  partyB: PartyOnchain;
  aAmount: bigint;
  bAmount: bigint;
  timeoutMs?: bigint;
  penaltyAmount?: bigint;
}): Promise<string> {
  const tx = new Transaction();
  buildOpenAndFundMany(tx, [
    {
      partyA: { ...opts.partyA, signatureType: SignatureScheme.ED25519 },
      partyB: { ...opts.partyB, signatureType: SignatureScheme.ED25519 },
      aAmount: opts.aAmount,
      bAmount: opts.bAmount,
      timeoutMs: opts.timeoutMs ?? 86_400_000n,
      penaltyAmount: opts.penaltyAmount ?? 0n,
    },
  ]);
  const { digest } = await opts.signExec(tx);
  await opts.reads.waitForTransaction({ digest });
  const txb = await opts.reads.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  });
  const tunnelId = findTunnelId(txb.objectChanges);
  if (!tunnelId) throw new Error("could not find created tunnel id");
  return tunnelId;
}

/**
 * Self-play open via the returnless `tunnel::create_and_fund` (no ID return; the tunnel id is
 * read from object changes). Same one-signature flow as {@link openAndFundSelfPlay}; used by
 * Quantum Poker, which reads the id from object changes and never chains it in the PTB (its
 * randomness is two-party commit-reveal, so no on-chain id/seed composition is needed).
 */
export async function openAndFundSelfPlayReturnless(opts: {
  reads: SuiReads;
  signExec: SignExec;
  partyA: PartyOnchain;
  partyB: PartyOnchain;
  aAmount: bigint;
  bAmount: bigint;
  timeoutMs?: bigint;
  penaltyAmount?: bigint;
}): Promise<string> {
  const tx = new Transaction();
  buildOpenAndFundOneReturnless(tx, {
    partyA: { ...opts.partyA, signatureType: SignatureScheme.ED25519 },
    partyB: { ...opts.partyB, signatureType: SignatureScheme.ED25519 },
    aAmount: opts.aAmount,
    bAmount: opts.bAmount,
    timeoutMs: opts.timeoutMs ?? 86_400_000n,
    penaltyAmount: opts.penaltyAmount ?? 0n,
  });
  const { digest } = await opts.signExec(tx);
  await opts.reads.waitForTransaction({ digest });
  const txb = await opts.reads.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  });
  const tunnelId = findTunnelId(txb.objectChanges);
  if (!tunnelId) throw new Error("could not find created tunnel id");
  return tunnelId;
}

/** Deposit this seat's stake; the Move routes it by sender address (gated). */
export async function depositStake(opts: {
  signExec: SignExec;
  tunnelId: string;
  amount: bigint;
}): Promise<void> {
  const tx = new Transaction();
  buildDepositFromGas(tx, { tunnelId: opts.tunnelId, amount: opts.amount });
  await opts.signExec(tx);
}

/** Read the on-chain created_at (ms) — the settlement timestamp must be >= this. */
export async function readCreatedAt(
  reads: SuiReads,
  tunnelId: string,
): Promise<bigint> {
  const obj = await reads.getObject({
    id: tunnelId,
    options: { showContent: true },
  });
  return BigInt((obj.data?.content?.fields?.created_at as string) ?? 0);
}

/** Cooperative close from the dual-signed settlement; pays the winner on-chain. */
export async function closeCooperative(opts: {
  signExec: SignExec;
  tunnelId: string;
  settlement: CoSignedSettlement;
}): Promise<string> {
  const tx = new Transaction();
  buildCloseFromSettlement(tx, opts.tunnelId, opts.settlement);
  const { digest } = await opts.signExec(tx);
  return digest;
}

/** Root-anchored cooperative close from a dual-signed CoSignedSettlementWithRoot. Anchors the
 *  transcript root on-chain (close_cooperative_with_root). Used as the wallet-submitted fallback
 *  when the backend /settle route is unavailable. */
export async function closeCooperativeWithRoot(opts: {
  signExec: SignExec;
  tunnelId: string;
  settlement: CoSignedSettlementWithRoot;
}): Promise<string> {
  const tx = new Transaction();
  buildCloseWithRootFromSettlement(tx, opts.tunnelId, opts.settlement);
  const { digest } = await opts.signExec(tx);
  return digest;
}

/**
 * Unilateral settlement floor, step 1: stake the latest BOTH-signed checkpoint on-chain via
 * `raise_dispute`, opening the on-chain timeout window. Used when the peer is gone and a fresh
 * cooperative co-signature is unavailable. `force_close` finalizes after `timeout_ms` (24h).
 */
export async function raiseDisputeUnilateral(opts: {
  signExec: SignExec;
  tunnelId: string;
  update: CoSignedUpdate;
  role: Party;
}): Promise<string> {
  const tx = new Transaction();
  buildRaiseDisputeFromUpdate(tx, opts.tunnelId, opts.update, opts.role);
  const { digest } = await opts.signExec(tx);
  return digest;
}

/** Unilateral settlement floor, step 2: finalize the staked dispute after the on-chain timeout. */
export async function forceCloseAfterTimeout(opts: {
  signExec: SignExec;
  tunnelId: string;
}): Promise<string> {
  const tx = new Transaction();
  buildForceClose(tx, { tunnelId: opts.tunnelId });
  const { digest } = await opts.signExec(tx);
  return digest;
}
