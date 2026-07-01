/**
 * Agent Spending Allowance Example
 *
 * Wraps the `agent_allowance` Move module: a delegated, capped,
 * rate-limited, pull-based payment mandate for autonomous agents — the
 * "OAuth for money" analog to Stripe Tempo Sessions and Cloudflare x402/MPP.
 *
 * Key concepts:
 * - A principal escrows funds payable ONLY to a fixed payee.
 * - The payee, or a delegate session key, PULLS what is owed with no per-charge
 *   counterparty signature, bounded by `min(spendCap, max(rateAccrual, voucher))`
 *   and the escrow balance.
 * - Continuous accrual (`ratePerSecond`) needs no off-chain message at all.
 * - Usage-metered authorization uses a principal-signed cumulative voucher.
 * - The principal can top up, retune, pause/resume, rotate the delegate, and
 *   revoke (which settles the payee's earned amount before refunding the rest).
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import {
  AllowanceStatus,
  buildTarget,
  MODULES,
  SignatureType,
  SUI_COIN_TYPE,
} from "../config";
import { sign } from "../core/crypto";
import { serializeSpendAuthorization } from "../core/wire";
import { CreateAllowanceResult } from "../types";
import {
  createSuiClient,
  getCreatedObjectId,
  getKeypairFromEnv,
  logTransactionResult,
  signAndExecute,
} from "../utils";

const EMPTY_BYTES = new Uint8Array(0);

/**
 * Parameters for creating an allowance. The voucher fields
 * (`principalPublicKey`/`signatureType`) are only needed if vouchers will be
 * used; leave the key empty for a pure rate- or sender-authorized mandate.
 */
export interface CreateAllowanceParams {
  /** The sole recipient of every claim. */
  payee: string;
  /** Object ID of the coin to escrow. */
  fundsCoinId: string;
  /** Hard lifetime ceiling on cumulative spend. */
  spendCap: bigint;
  /** Continuous accrual rate in base units per second (default 0 = none). */
  ratePerSecond?: bigint;
  /** Optional session-key agent allowed to trigger claims (default none). */
  delegate?: string | null;
  /** Absolute time (ms) at which rate accrual stops (default 0 = open-ended). */
  expiryMs?: bigint;
  /** Principal public key for verifying vouchers (default empty). */
  principalPublicKey?: Uint8Array;
  /** Signature scheme of `principalPublicKey` (default ed25519). */
  signatureType?: number;
  /** Coin type to denominate the allowance in (default SUI; e.g. USDC). */
  coinType?: string;
}

// ============================================
// LIFECYCLE
// ============================================

/**
 * Create a spending allowance and share it so the payee/delegate can pull.
 *
 * @returns The created allowance ID and transaction digest.
 *
 * @example
 * ```typescript
 * // Stream up to 1 SUI total at 1000 MIST/sec, with an agent delegate.
 * const { allowanceId } = await createAndShareAllowance({
 *   payee: providerAddress,
 *   fundsCoinId: coinId,
 *   spendCap: 1_000_000_000n,
 *   ratePerSecond: 1000n,
 *   delegate: agentAddress,
 * });
 * ```
 */
export async function createAndShareAllowance(
  params: CreateAllowanceParams,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<CreateAllowanceResult> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const coinType = params.coinType ?? SUI_COIN_TYPE;
  const tx = new Transaction();

  // public fun create_and_share_allowance(
  //   payee, delegate, principal_public_key, principal_signature_type, funds,
  //   rate_per_second, spend_cap, expiry_ms, clock, ctx)
  tx.moveCall({
    target: buildTarget(
      MODULES.agent_allowance,
      "create_and_share_allowance"
    ),
    typeArguments: [coinType],
    arguments: [
      tx.pure.address(params.payee),
      tx.pure.option("address", params.delegate ?? null),
      tx.pure.vector(
        "u8",
        Array.from(params.principalPublicKey ?? EMPTY_BYTES)
      ),
      tx.pure.u8(params.signatureType ?? SignatureType.ED25519),
      tx.object(params.fundsCoinId),
      tx.pure.u64(params.ratePerSecond ?? 0n),
      tx.pure.u64(params.spendCap),
      tx.pure.u64(params.expiryMs ?? 0n),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  const allowanceId = getCreatedObjectId(result.objectChanges, "Allowance");

  if (!allowanceId) {
    throw new Error("Failed to get created Allowance ID");
  }

  logTransactionResult(result, "Create Allowance");

  return { allowanceId, digest: result.digest };
}

// ============================================
// CLAIMING (pull-based settlement)
// ============================================

/**
 * Pull `amount` to the payee. Callable by the payee, delegate, or principal;
 * funds always flow to the payee. `amount` may not exceed the claimable amount.
 */
export async function claim(
  allowanceId: string,
  amount: bigint,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
  coinType: string = SUI_COIN_TYPE
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();
  // public fun claim(allowance, amount, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.agent_allowance, "claim"),
    typeArguments: [coinType],
    arguments: [
      tx.object(allowanceId),
      tx.pure.u64(amount),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Claim");
  return result.digest;
}

/**
 * Sign a cumulative spend voucher with the principal's raw ed25519 secret key.
 * Produces the 64-byte signature `authorize_spend` / `claim_with_voucher` expect.
 * The signed bytes are byte-identical to the Move `serialize_spend_authorization`.
 */
export function signSpendVoucher(
  allowanceId: string,
  authorizedTotal: bigint,
  principalSecretKey: Uint8Array
): Uint8Array {
  const message = serializeSpendAuthorization({ allowanceId, authorizedTotal });
  return sign(message, principalSecretKey);
}

/**
 * Record a principal-signed cumulative voucher, raising the authorized total.
 * The signature alone authorizes this, so any holder (typically the payee) may
 * submit it. `authorizedTotal` must strictly exceed the current one and stay
 * within the spend cap.
 */
export async function authorizeSpend(
  allowanceId: string,
  authorizedTotal: bigint,
  voucherSignature: Uint8Array,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
  coinType: string = SUI_COIN_TYPE
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();
  // public fun authorize_spend(allowance, authorized_total, voucher_signature)
  tx.moveCall({
    target: buildTarget(MODULES.agent_allowance, "authorize_spend"),
    typeArguments: [coinType],
    arguments: [
      tx.object(allowanceId),
      tx.pure.u64(authorizedTotal),
      tx.pure.vector("u8", Array.from(voucherSignature)),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Authorize Spend");
  return result.digest;
}

/**
 * Record a voucher and immediately pull `amount`, in one transaction.
 */
export async function claimWithVoucher(
  allowanceId: string,
  authorizedTotal: bigint,
  voucherSignature: Uint8Array,
  amount: bigint,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
  coinType: string = SUI_COIN_TYPE
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();
  // public fun claim_with_voucher(allowance, authorized_total, voucher_signature, amount, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.agent_allowance, "claim_with_voucher"),
    typeArguments: [coinType],
    arguments: [
      tx.object(allowanceId),
      tx.pure.u64(authorizedTotal),
      tx.pure.vector("u8", Array.from(voucherSignature)),
      tx.pure.u64(amount),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Claim With Voucher");
  return result.digest;
}

// ============================================
// PRINCIPAL CONTROLS
// ============================================

/** Add escrow to a live allowance (principal only). */
export async function topUp(
  allowanceId: string,
  fundsCoinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
  coinType: string = SUI_COIN_TYPE
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();
  // public fun top_up(allowance, funds, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.agent_allowance, "top_up"),
    typeArguments: [coinType],
    arguments: [tx.object(allowanceId), tx.object(fundsCoinId)],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Top Up Allowance");
  return result.digest;
}

/** Change the streaming rate (principal only); accrual to date is folded in. */
export async function setRate(
  allowanceId: string,
  newRatePerSecond: bigint,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
  coinType: string = SUI_COIN_TYPE
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();
  // public fun set_rate(allowance, new_rate_per_second, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.agent_allowance, "set_rate"),
    typeArguments: [coinType],
    arguments: [
      tx.object(allowanceId),
      tx.pure.u64(newRatePerSecond),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Set Rate");
  return result.digest;
}

/** Raise the lifetime spend cap (principal only; cap can only increase). */
export async function increaseCap(
  allowanceId: string,
  newSpendCap: bigint,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
  coinType: string = SUI_COIN_TYPE
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();
  // public fun increase_cap(allowance, new_spend_cap, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.agent_allowance, "increase_cap"),
    typeArguments: [coinType],
    arguments: [tx.object(allowanceId), tx.pure.u64(newSpendCap)],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Increase Cap");
  return result.digest;
}

/** Freeze accrual and block claims until resumed (principal only). */
export async function pauseAllowance(
  allowanceId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
  coinType: string = SUI_COIN_TYPE
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();
  // public fun pause(allowance, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.agent_allowance, "pause"),
    typeArguments: [coinType],
    arguments: [tx.object(allowanceId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Pause Allowance");
  return result.digest;
}

/** Resume a paused allowance; the paused interval is not credited (principal only). */
export async function resumeAllowance(
  allowanceId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
  coinType: string = SUI_COIN_TYPE
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();
  // public fun resume(allowance, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.agent_allowance, "resume"),
    typeArguments: [coinType],
    arguments: [tx.object(allowanceId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Resume Allowance");
  return result.digest;
}

/** Set, rotate, or clear the delegate session key (principal only). */
export async function setDelegate(
  allowanceId: string,
  delegate: string | null,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
  coinType: string = SUI_COIN_TYPE
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();
  // public fun set_delegate(allowance, delegate, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.agent_allowance, "set_delegate"),
    typeArguments: [coinType],
    arguments: [
      tx.object(allowanceId),
      tx.pure.option("address", delegate ?? null),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Set Delegate");
  return result.digest;
}

/**
 * Revoke the allowance (principal only): settles the payee's earned-but-unclaimed
 * amount, refunds the remainder to the principal, and marks the allowance terminal.
 */
export async function revokeAllowance(
  allowanceId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
  coinType: string = SUI_COIN_TYPE
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();
  // public fun revoke(allowance, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.agent_allowance, "revoke"),
    typeArguments: [coinType],
    arguments: [tx.object(allowanceId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Revoke Allowance");
  return result.digest;
}

// ============================================
// OFF-CHAIN VIEW HELPERS (mirror the Move accrual math)
// ============================================

/** Subset of an allowance's accrual fields needed to predict entitlement. */
export interface AccrualState {
  ratePerSecond: bigint;
  vestedFloor: bigint;
  anchorMs: bigint;
  authorizedTotal: bigint;
  spendCap: bigint;
  /** 0 = open-ended. */
  expiryMs: bigint;
  status: number;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function rateVested(s: AccrualState, nowMs: bigint): bigint {
  if (s.status !== AllowanceStatus.ACTIVE) {
    return minBig(s.vestedFloor, s.spendCap);
  }
  const deadline = s.expiryMs === 0n ? nowMs : minBig(s.expiryMs, nowMs);
  const elapsedSecs =
    deadline > s.anchorMs ? (deadline - s.anchorMs) / 1000n : 0n;
  const accrued = s.vestedFloor + s.ratePerSecond * elapsedSecs;
  return minBig(accrued, s.spendCap);
}

/**
 * Total entitlement at `nowMs`: `min(spendCap, max(rateVested, authorizedTotal))`.
 * Mirrors `agent_allowance::entitled_at`.
 */
export function computeEntitled(s: AccrualState, nowMs: bigint): bigint {
  const byRate = rateVested(s, nowMs);
  const e = byRate > s.authorizedTotal ? byRate : s.authorizedTotal;
  return minBig(e, s.spendCap);
}

/**
 * Amount the payee can pull right now: `min(entitled - spent, escrow)`, or 0 if
 * the allowance is not active. Mirrors `available_to_claim`.
 */
export function computeAvailable(
  s: AccrualState,
  spent: bigint,
  escrowBalance: bigint,
  nowMs: bigint
): bigint {
  if (s.status !== AllowanceStatus.ACTIVE) return 0n;
  const entitled = computeEntitled(s, nowMs);
  const unspent = entitled > spent ? entitled - spent : 0n;
  return minBig(unspent, escrowBalance);
}

/** Human-readable allowance status name. */
export function getAllowanceStatusName(status: number): string {
  switch (status) {
    case AllowanceStatus.ACTIVE:
      return "Active";
    case AllowanceStatus.PAUSED:
      return "Paused";
    case AllowanceStatus.REVOKED:
      return "Revoked";
    default:
      return "Unknown";
  }
}

// ============================================
// EXAMPLE USAGE
// ============================================

/**
 * Documentation-only walkthrough of the agent allowance flow (no live tx).
 */
export async function exampleAgentAllowanceFlow(): Promise<void> {
  console.log("=== Agent Spending Allowance Example ===\n");

  console.log("Use cases:");
  console.log("- Autonomous agent paying a metered API (x402 / MPP style)");
  console.log("- Continuous service streaming (Tempo Sessions style)");
  console.log("- A principal granting an agent a capped, revocable budget\n");

  console.log("How it works:");
  console.log(
    "1. Principal escrows funds and sets payee + cap + (rate | voucher key)"
  );
  console.log(
    "2. Payee or delegate PULLS what is owed — no per-charge co-signature"
  );
  console.log(
    "3. Entitlement = min(spendCap, max(rateAccrual, signedVoucher))"
  );
  console.log(
    "4. Principal can top up / retune / pause / revoke at any time\n"
  );

  // Off-chain prediction of claimable funds (no chain needed).
  const start = 0n;
  const state: AccrualState = {
    ratePerSecond: 1000n,
    vestedFloor: 0n,
    anchorMs: start,
    authorizedTotal: 0n,
    spendCap: 1_000_000n,
    expiryMs: 0n,
    status: AllowanceStatus.ACTIVE,
  };
  console.log("Rate accrual (1000/sec, cap 1_000_000):");
  console.log(`- t=0s:   ${computeEntitled(state, start)} entitled`);
  console.log(`- t=10s:  ${computeEntitled(state, start + 10_000n)} entitled`);
  console.log(
    `- t=2000s: ${computeEntitled(
      state,
      start + 2_000_000n
    )} entitled (cap clamps)\n`
  );

  console.log("Voucher signing (usage-metered, no chain needed):");
  console.log(`
import { generateKeyPair } from "sui-tunnel-ts/core";
const principal = generateKeyPair();
const sig = signSpendVoucher(allowanceId, 500n, principal.secretKey);
await authorizeSpend(allowanceId, 500n, sig); // payee submits the principal's voucher
await claim(allowanceId, 500n);
`);
}

// Run example if called directly
if (require.main === module) {
  exampleAgentAllowanceFlow();
}
