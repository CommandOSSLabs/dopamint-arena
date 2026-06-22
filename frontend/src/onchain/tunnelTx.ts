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
} from "sui-tunnel-ts/onchain/createAndFund";
import {
  buildDeposit as sdkDeposit,
  buildDepositFromGas as sdkDepositFromGas,
  buildCloseFromSettlement as sdkCloseFromSettlement,
  buildCloseWithRootFromSettlement as sdkCloseWithRootFromSettlement,
} from "sui-tunnel-ts/onchain/txbuilders";
import { SignatureScheme } from "sui-tunnel-ts/core/crypto";
import type { CoSignedSettlement, CoSignedSettlementWithRoot } from "sui-tunnel-ts/core/tunnel";

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
const buildDeposit = sdkDeposit as unknown as (
  tx: Transaction,
  p: Parameters<typeof sdkDeposit>[1],
) => void;
const buildCloseFromSettlement = sdkCloseFromSettlement as unknown as (
  tx: Transaction,
  tunnelId: string,
  settlement: Parameters<typeof sdkCloseFromSettlement>[2],
  coinType?: string,
) => void;
const buildCloseWithRootFromSettlement = sdkCloseWithRootFromSettlement as unknown as (
  tx: Transaction,
  tunnelId: string,
  settlement: Parameters<typeof sdkCloseWithRootFromSettlement>[2],
  coinType?: string,
) => void;
const buildOpenAndFundMany = sdkOpenAndFundMany as unknown as (
  tx: Transaction,
  specs: Parameters<typeof sdkOpenAndFundMany>[1],
  opts?: Parameters<typeof sdkOpenAndFundMany>[2],
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
  /** Split seat A's stake from this user coin (gas-sponsored path); else from the gas coin. */
  stakeCoinId?: string;
  /** Coin type `T` for the tunnel; defaults to SUI. Pass DOPAMINT to stake the faucet token. */
  coinType?: string;
}): Promise<string> {
  const tx = new Transaction();
  buildOpenAndFundSeatA(tx, {
    partyA: { ...opts.partyA, signatureType: SignatureScheme.ED25519 },
    partyB: { ...opts.partyB, signatureType: SignatureScheme.ED25519 },
    aAmount: opts.amount,
    timeoutMs: opts.timeoutMs ?? 86_400_000n,
    penaltyAmount: opts.penaltyAmount ?? 0n,
    stakeCoin: opts.stakeCoinId ? tx.object(opts.stakeCoinId) : undefined,
    coinType: opts.coinType,
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
  /** Split BOTH seats' stakes from this user coin (gas-sponsored path); else from the gas coin. */
  stakeCoinId?: string;
  /** Coin type `T` for the tunnels; defaults to SUI. Pass DOPAMINT to stake the faucet token. */
  coinType?: string;
}): Promise<string> {
  const tx = new Transaction();
  buildOpenAndFundMany(
    tx,
    [
      {
        partyA: { ...opts.partyA, signatureType: SignatureScheme.ED25519 },
        partyB: { ...opts.partyB, signatureType: SignatureScheme.ED25519 },
        aAmount: opts.aAmount,
        bAmount: opts.bAmount,
        timeoutMs: opts.timeoutMs ?? 86_400_000n,
        penaltyAmount: opts.penaltyAmount ?? 0n,
      },
    ],
    {
      coinType: opts.coinType,
      sourceCoin: opts.stakeCoinId ? tx.object(opts.stakeCoinId) : undefined,
    },
  );
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

/** Deposit this seat's stake; the Move routes it by sender address (gated). With `stakeCoinId`
 *  the stake is split off that user coin (gas-sponsored path); otherwise off the gas coin. */
export async function depositStake(opts: {
  signExec: SignExec;
  tunnelId: string;
  amount: bigint;
  stakeCoinId?: string;
  /** Coin type `T`; defaults to SUI. Pass DOPAMINT to deposit the faucet token. */
  coinType?: string;
}): Promise<void> {
  const tx = new Transaction();
  if (opts.stakeCoinId) {
    const [coin] = tx.splitCoins(tx.object(opts.stakeCoinId), [
      tx.pure.u64(opts.amount),
    ]);
    buildDeposit(tx, { tunnelId: opts.tunnelId, coin, coinType: opts.coinType });
  } else {
    buildDepositFromGas(tx, { tunnelId: opts.tunnelId, amount: opts.amount });
  }
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
  coinType?: string;
}): Promise<string> {
  const tx = new Transaction();
  buildCloseFromSettlement(tx, opts.tunnelId, opts.settlement, opts.coinType);
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
  coinType?: string;
}): Promise<string> {
  const tx = new Transaction();
  buildCloseWithRootFromSettlement(
    tx,
    opts.tunnelId,
    opts.settlement,
    opts.coinType,
  );
  const { digest } = await opts.signExec(tx);
  return digest;
}
