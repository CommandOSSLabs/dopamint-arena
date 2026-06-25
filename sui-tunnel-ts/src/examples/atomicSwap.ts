/**
 * Atomic Swap Example
 *
 * Demonstrates how to use the example_atomic_swap Move module for:
 * - Creating hash time-locked swaps
 * - Claiming swaps with secret
 * - Refunding expired swaps
 *
 * Key Concepts:
 * - HTLC (Hash Time-Locked Contract) pattern
 * - Atomic: either both swaps complete or neither does
 * - Cascading timeouts ensure fairness
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import {
  buildTarget,
  MIN_LOCK_TIME_MS,
  MODULES,
  SUI_COIN_TYPE,
  SwapStatus,
} from "../config";
import { CreateSwapResult } from "../types";
import {
  blake2b256,
  bytesToHex,
  createSuiClient,
  formatDuration,
  generateSecret,
  getCreatedObjectId,
  getKeypairFromEnv,
  logError,
  logTransactionResult,
  now,
  signAndExecute,
} from "../utils";

// ============================================
// ATOMIC SWAP FUNCTIONS
// ============================================

/**
 * Create a new swap lock (initiator creates first)
 *
 * @param claimer - Address who can claim with the secret
 * @param paymentCoinId - Object ID of the SUI coin to lock
 * @param secretHash - Hash of the secret (blake2b256)
 * @param lockDurationMs - How long until the lock expires
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (locker)
 * @returns The created swap ID and transaction digest
 *
 * @example
 * ```typescript
 * // Generate secret and hash
 * const secret = generateSecret();
 * const secretHash = blake2b256(secret);
 *
 * // Create swap lock
 * const result = await createSwapLock(
 *   "0x1234...claimer_address",
 *   "0xabcd...coin_id",
 *   secretHash,
 *   2n * 60n * 60n * 1000n  // 2 hours
 * );
 * console.log("Swap created:", result.swapId);
 * // IMPORTANT: Save the secret! Share secretHash with counterparty
 * ```
 */
export async function createSwapLock(
  claimer: string,
  paymentCoinId: string,
  secretHash: Uint8Array,
  lockDurationMs: bigint,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<CreateSwapResult> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  if (lockDurationMs < BigInt(MIN_LOCK_TIME_MS)) {
    throw new Error(
      `Lock duration must be at least ${formatDuration(
        BigInt(MIN_LOCK_TIME_MS)
      )}`
    );
  }

  const tx = new Transaction();

  // Call create_swap_lock function
  // public fun create_swap_lock(claimer, payment, secret_hash, lock_duration_ms, clock, ctx)
  const swap = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ATOMIC_SWAP, "create_swap_lock"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.pure.address(claimer),
      tx.object(paymentCoinId),
      tx.pure.vector("u8", Array.from(secretHash)),
      tx.pure.u64(lockDurationMs),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  // Share the swap so claimer can access it
  tx.moveCall({
    target: "0x2::transfer::public_share_object",
    typeArguments: [
      `${buildTarget(
        MODULES.EXAMPLE_ATOMIC_SWAP,
        "SwapLock"
      )}<${SUI_COIN_TYPE}>`,
    ],
    arguments: [swap],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  const swapId = getCreatedObjectId(result.objectChanges, "SwapLock");

  if (!swapId) {
    throw new Error("Failed to get created SwapLock ID");
  }

  logTransactionResult(result, "Create Swap Lock");

  return {
    swapId,
    digest: result.digest,
  };
}

/**
 * Create a matching swap lock (responder creates second)
 * Uses the same secret hash but shorter timeout
 *
 * @param initiatorSwapId - The initiator's swap lock ID
 * @param paymentCoinId - Object ID of the SUI coin to lock
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (responder)
 * @returns The created swap ID and transaction digest
 *
 * @example
 * ```typescript
 * const result = await createMatchingSwap(
 *   "0xinitiator_swap_id...",
 *   "0xmy_coin_id..."
 * );
 * console.log("Matching swap created:", result.swapId);
 * ```
 */
export async function createMatchingSwap(
  initiatorSwapId: string,
  paymentCoinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<CreateSwapResult> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call create_matching_swap function
  // public fun create_matching_swap(initiator_swap, payment, clock, ctx)
  const swap = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ATOMIC_SWAP, "create_matching_swap"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(initiatorSwapId),
      tx.object(paymentCoinId),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  // Share the swap
  tx.moveCall({
    target: "0x2::transfer::public_share_object",
    typeArguments: [
      `${buildTarget(
        MODULES.EXAMPLE_ATOMIC_SWAP,
        "SwapLock"
      )}<${SUI_COIN_TYPE}>`,
    ],
    arguments: [swap],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  const swapId = getCreatedObjectId(result.objectChanges, "SwapLock");

  if (!swapId) {
    throw new Error("Failed to get created SwapLock ID");
  }

  logTransactionResult(result, "Create Matching Swap");

  return {
    swapId,
    digest: result.digest,
  };
}

/**
 * Claim a swap by revealing the secret
 *
 * @param swapId - The swap lock object ID
 * @param secret - The preimage of the secret hash
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be claimer)
 * @returns Transaction digest and claimed coin ID
 *
 * @example
 * ```typescript
 * const result = await claimSwap("0xswap_id...", mySecret);
 * console.log("Swap claimed! Coin:", result.coinId);
 * ```
 */
export async function claimSwap(
  swapId: string,
  secret: Uint8Array,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<{ digest: string; coinId: string | null; receipt: any }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call claim_swap function
  // public fun claim_swap(swap, secret, clock, ctx)
  const [coin, receipt] = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ATOMIC_SWAP, "claim_swap"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(swapId),
      tx.pure.vector("u8", Array.from(secret)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress())
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Claim Swap");

  return {
    digest: result.digest,
    coinId,
    receipt: result.events?.[0]?.parsedJson || null,
  };
}

/**
 * Claim a swap using a receipt from another swap (reveals the secret)
 *
 * @param swapId - The swap lock object ID to claim
 * @param receiptSwapId - The swap whose receipt contains the secret
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest and claimed coin ID
 */
export async function claimWithReceipt(
  swapId: string,
  receipt: { secret: Uint8Array },
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<{ digest: string; coinId: string | null }> {
  // In practice, you'd extract the secret from the receipt and use claimSwap
  return claimSwap(swapId, receipt.secret, client, keypair);
}

/**
 * Refund an expired swap lock
 *
 * @param swapId - The swap lock object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be locker)
 * @returns Transaction digest and refunded coin ID
 *
 * @example
 * ```typescript
 * // After swap expires...
 * const result = await refundExpired("0xswap_id...");
 * console.log("Funds refunded!");
 * ```
 */
export async function refundExpired(
  swapId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call refund_expired function
  // public fun refund_expired(swap, clock, ctx)
  const coin = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ATOMIC_SWAP, "refund_expired"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(swapId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress())
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Refund Expired");

  return {
    digest: result.digest,
    coinId,
  };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Generate a new secret and its hash
 */
export function generateSecretAndHash(): {
  secret: Uint8Array;
  hash: Uint8Array;
} {
  const secret = generateSecret(32);
  const hash = blake2b256(secret);
  return { secret, hash };
}

/**
 * Compute the hash of a secret
 */
export function computeSecretHash(secret: Uint8Array): Uint8Array {
  return blake2b256(secret);
}

/**
 * Get swap status name from status value
 */
export function getSwapStatusName(status: number): string {
  switch (status) {
    case SwapStatus.LOCKED:
      return "Locked";
    case SwapStatus.CLAIMED:
      return "Claimed";
    case SwapStatus.REFUNDED:
      return "Refunded";
    default:
      return "Unknown";
  }
}

/**
 * Calculate remaining time until swap expires
 */
export function timeRemaining(expiresAt: bigint): bigint {
  const currentTime = now();
  return expiresAt > currentTime ? expiresAt - currentTime : 0n;
}

/**
 * Check if a swap is still claimable
 */
export function isClaimable(status: number, expiresAt: bigint): boolean {
  return status === SwapStatus.LOCKED && now() < expiresAt;
}

/**
 * Check if a swap is refundable
 */
export function isRefundable(status: number, expiresAt: bigint): boolean {
  return status === SwapStatus.LOCKED && now() >= expiresAt;
}

// ============================================
// EXAMPLE USAGE
// ============================================

/**
 * Complete atomic swap flow example
 */
export async function exampleAtomicSwapFlow(): Promise<void> {
  console.log("=== Atomic Swap Example ===\n");

  try {
    console.log("What is an Atomic Swap?");
    console.log("- Trustless exchange between two parties");
    console.log("- Uses HTLC (Hash Time-Locked Contract)");
    console.log("- Either both swaps complete or neither does\n");

    console.log("Flow:");
    console.log("1. Alice generates secret, creates swap with hash(secret)");
    console.log(
      "2. Bob sees Alice's swap, creates matching swap with same hash"
    );
    console.log("3. Alice claims Bob's swap by revealing secret");
    console.log("4. Bob uses revealed secret to claim Alice's swap");
    console.log("5. If either doesn't claim in time, funds are refunded\n");

    console.log("Cascading Timeouts:");
    console.log(`- Initiator's lock: 2 hours`);
    console.log(`- Responder's lock: 1.5 hours (30 min less)`);
    console.log(
      "- This ensures initiator can always claim responder's swap first\n"
    );

    console.log("Example Code:");
    console.log(`
// === Alice (Initiator) ===

// 1. Generate secret
const { secret, hash: secretHash } = generateSecretAndHash();
console.log("Secret (KEEP SAFE!):", bytesToHex(secret));
console.log("Secret Hash (share with Bob):", bytesToHex(secretHash));

// 2. Create swap lock
const aliceSwap = await createSwapLock(
  bobAddress,
  aliceCoinId,
  secretHash,
  2n * 60n * 60n * 1000n  // 2 hours
);

// === Bob (Responder) ===

// 3. Create matching swap with same hash (shorter timeout)
const bobSwap = await createMatchingSwap(
  aliceSwap.swapId,
  bobCoinId
);

// === Alice claims Bob's swap ===

// 4. Alice reveals secret to claim
const aliceClaim = await claimSwap(bobSwap.swapId, secret);
// This reveals the secret on-chain!

// === Bob claims Alice's swap ===

// 5. Bob reads secret from Alice's claim transaction
const revealedSecret = extractSecretFromReceipt(aliceClaim);
const bobClaim = await claimSwap(aliceSwap.swapId, revealedSecret);

// === Swap complete! ===
`);

    // Demonstrate secret generation
    console.log("\nSecret Generation Example:");
    const { secret, hash } = generateSecretAndHash();
    console.log("Secret:", bytesToHex(secret));
    console.log("Hash:  ", bytesToHex(hash));
    console.log(
      "\nVerify: computeSecretHash(secret) === hash:",
      bytesToHex(computeSecretHash(secret)) === bytesToHex(hash)
    );
  } catch (error) {
    logError(error, "exampleAtomicSwapFlow");
  }
}

// Run example if called directly
if (require.main === module) {
  exampleAtomicSwapFlow();
}
