/**
 * Streaming Payment Example
 *
 * Demonstrates how to use the example_streaming_payment Move module for:
 * - Creating payment streams
 * - Withdrawing unlocked funds
 * - Cancelling streams
 * - Topping up streams
 *
 * Key Concepts:
 * - Funds unlock linearly over time
 * - Recipient can withdraw any time (up to unlocked amount)
 * - Sender can cancel (pro-rata refund)
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import {
  buildTarget,
  MIN_STREAM_DURATION_MS,
  MODULES,
  StreamStatus,
  SUI_COIN_TYPE,
} from "../config";
import { CreateStreamResult } from "../types";
import {
  createSuiClient,
  formatDuration,
  getCreatedObjectId,
  getKeypairFromEnv,
  logError,
  logTransactionResult,
  signAndExecute,
  stringToBytes,
} from "../utils";

// ============================================
// STREAMING PAYMENT FUNCTIONS
// ============================================

/**
 * Create a new payment stream
 *
 * @param recipient - Address of the recipient
 * @param paymentCoinId - Object ID of the SUI coin to stream
 * @param durationMs - Duration of the stream in milliseconds
 * @param memo - Optional memo/description
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (sender)
 * @returns The created stream ID and transaction digest
 *
 * @example
 * ```typescript
 * // Create a 30-day salary stream
 * const thirtyDays = 30n * 24n * 60n * 60n * 1000n;
 * const result = await createStream(
 *   "0x1234...employee_address",
 *   "0xabcd...coin_id",
 *   thirtyDays,
 *   "Monthly salary - January 2024"
 * );
 * console.log("Stream created:", result.streamId);
 * ```
 */
export async function createStream(
  recipient: string,
  paymentCoinId: string,
  durationMs: bigint,
  memo: string = "",
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<CreateStreamResult> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  if (durationMs < BigInt(MIN_STREAM_DURATION_MS)) {
    throw new Error(
      `Duration must be at least ${formatDuration(
        BigInt(MIN_STREAM_DURATION_MS),
      )}`,
    );
  }

  const tx = new Transaction();

  // Call create_stream function
  // public fun create_stream(recipient, payment, duration_ms, memo, clock, ctx)
  const stream = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_STREAMING_PAYMENT, "create_stream"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.pure.address(recipient),
      tx.object(paymentCoinId),
      tx.pure.u64(durationMs),
      tx.pure.vector("u8", Array.from(stringToBytes(memo))),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  // Share the stream so recipient can access it
  tx.moveCall({
    target: "0x2::transfer::public_share_object",
    typeArguments: [
      `${buildTarget(
        MODULES.EXAMPLE_STREAMING_PAYMENT,
        "PaymentStream",
      )}<${SUI_COIN_TYPE}>`,
    ],
    arguments: [stream],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  const streamId = getCreatedObjectId(result.objectChanges, "PaymentStream");

  if (!streamId) {
    throw new Error("Failed to get created PaymentStream ID");
  }

  logTransactionResult(result, "Create Stream");

  return {
    streamId,
    digest: result.digest,
  };
}

/**
 * Withdraw all unlocked funds from a stream
 *
 * @param streamId - The stream object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be recipient)
 * @returns Transaction digest and withdrawn coin ID
 *
 * @example
 * ```typescript
 * const result = await withdraw("0xstream_id...");
 * console.log("Withdrawn funds:", result.coinId);
 * ```
 */
export async function withdraw(
  streamId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call withdraw function
  // public fun withdraw(stream, clock, ctx)
  const [coin, receipt] = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_STREAMING_PAYMENT, "withdraw"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(streamId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Withdraw");

  return {
    digest: result.digest,
    coinId,
  };
}

/**
 * Withdraw a specific amount from a stream
 *
 * @param streamId - The stream object ID
 * @param amount - Amount to withdraw (must be <= unlocked amount)
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be recipient)
 * @returns Transaction digest and withdrawn coin ID
 *
 * @example
 * ```typescript
 * // Withdraw exactly 100 SUI
 * const result = await withdrawAmount("0xstream_id...", 100_000_000_000n);
 * ```
 */
export async function withdrawAmount(
  streamId: string,
  amount: bigint,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call withdraw_amount function
  // public fun withdraw_amount(stream, amount, clock, ctx)
  const [coin, receipt] = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_STREAMING_PAYMENT, "withdraw_amount"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(streamId),
      tx.pure.u64(amount),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Withdraw Amount");

  return {
    digest: result.digest,
    coinId,
  };
}

/**
 * Cancel a stream and get refund (sender only)
 *
 * @param streamId - The stream object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be sender)
 * @returns Transaction digest and coin IDs (recipient's portion and refund)
 *
 * @example
 * ```typescript
 * const result = await cancelStream("0xstream_id...");
 * console.log("Stream cancelled, refund received");
 * ```
 */
export async function cancelStream(
  streamId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{
  digest: string;
  recipientCoinId: string | null;
  refundCoinId: string | null;
}> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call cancel_stream function
  // public fun cancel_stream(stream, clock, ctx)
  const [recipientCoin, refundCoin, receipt] = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_STREAMING_PAYMENT, "cancel_stream"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(streamId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  // Transfer both coins to the caller - in practice, recipient coin would go to recipient
  tx.transferObjects(
    [recipientCoin, refundCoin],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinIds =
    result.objectChanges
      ?.filter(
        (c: any) => c.type === "created" && c.objectType?.includes("Coin"),
      )
      .map((c: any) => c.objectId) || [];

  logTransactionResult(result, "Cancel Stream");

  return {
    digest: result.digest,
    recipientCoinId: coinIds[0] || null,
    refundCoinId: coinIds[1] || null,
  };
}

/**
 * Top up an existing stream
 *
 * @param streamId - The stream object ID
 * @param additionalCoinId - Object ID of additional SUI coin
 * @param additionalDurationMs - Optional additional duration
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be sender)
 * @returns Transaction digest
 *
 * @example
 * ```typescript
 * // Add more funds and extend duration
 * await topUpStream("0xstream_id...", "0xcoin_id...", 7n * 24n * 60n * 60n * 1000n);
 * ```
 */
export async function topUpStream(
  streamId: string,
  additionalCoinId: string,
  additionalDurationMs: bigint = 0n,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call top_up function
  // public fun top_up(stream, additional, additional_duration_ms, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_STREAMING_PAYMENT, "top_up"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(streamId),
      tx.object(additionalCoinId),
      tx.pure.u64(additionalDurationMs),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Top Up Stream");

  return result.digest;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Calculate how much is unlocked at a given time
 */
export function calculateUnlocked(
  totalAmount: bigint,
  startTime: bigint,
  endTime: bigint,
  currentTime: bigint,
): bigint {
  if (currentTime <= startTime) return 0n;
  if (currentTime >= endTime) return totalAmount;

  const elapsed = currentTime - startTime;
  const duration = endTime - startTime;
  return (totalAmount * elapsed) / duration;
}

/**
 * Calculate available (unlocked but not withdrawn) amount
 */
export function calculateAvailable(
  totalAmount: bigint,
  withdrawnAmount: bigint,
  startTime: bigint,
  endTime: bigint,
  currentTime: bigint,
): bigint {
  const unlocked = calculateUnlocked(
    totalAmount,
    startTime,
    endTime,
    currentTime,
  );
  return unlocked > withdrawnAmount ? unlocked - withdrawnAmount : 0n;
}

/**
 * Get stream status name from status value
 */
export function getStreamStatusName(status: number): string {
  switch (status) {
    case StreamStatus.ACTIVE:
      return "Active";
    case StreamStatus.COMPLETED:
      return "Completed";
    case StreamStatus.CANCELLED:
      return "Cancelled";
    default:
      return "Unknown";
  }
}

/**
 * Calculate streaming rate per millisecond
 */
export function calculateRate(totalAmount: bigint, durationMs: bigint): bigint {
  return totalAmount / durationMs;
}

// ============================================
// EXAMPLE USAGE
// ============================================

/**
 * Complete streaming payment flow example
 */
export async function exampleStreamingPaymentFlow(): Promise<void> {
  console.log("=== Streaming Payment Example ===\n");

  try {
    console.log("Use Cases:");
    console.log("- Salary streaming (get paid every second!)");
    console.log("- Subscription payments");
    console.log("- Vesting schedules");
    console.log("- Service billing\n");

    console.log("How it works:");
    console.log("1. Sender creates stream with total amount and duration");
    console.log(
      "2. Funds unlock linearly: unlocked = total * (elapsed / duration)",
    );
    console.log("3. Recipient can withdraw unlocked funds anytime");
    console.log(
      "4. Sender can cancel (recipient gets earned, sender gets refund)\n",
    );

    console.log("Example:");
    console.log(`
// Create a 30-day stream for 1000 SUI
const thirtyDays = 30n * 24n * 60n * 60n * 1000n;
const stream = await createStream(
  recipientAddress,
  coinId,
  thirtyDays,
  "Salary - January 2024"
);

// After 15 days, recipient can withdraw ~500 SUI
await withdraw(stream.streamId);

// Or withdraw specific amount
await withdrawAmount(stream.streamId, 100_000_000_000n); // 100 SUI

// Sender can cancel and get refund for remaining
await cancelStream(stream.streamId);

// Or top up to extend the stream
await topUpStream(stream.streamId, additionalCoinId, 7n * 24n * 60n * 60n * 1000n);
`);

    // Calculate example
    const totalAmount = 1000_000_000_000n; // 1000 SUI
    const duration = 30n * 24n * 60n * 60n * 1000n; // 30 days
    const startTime = 0n;
    const endTime = duration;

    console.log("\nUnlocking Schedule (1000 SUI over 30 days):");
    console.log(
      "- Day 0:  " +
        calculateUnlocked(totalAmount, startTime, endTime, 0n) +
        " MIST unlocked",
    );
    console.log(
      "- Day 7:  " +
        calculateUnlocked(
          totalAmount,
          startTime,
          endTime,
          7n * 24n * 60n * 60n * 1000n,
        ) +
        " MIST unlocked",
    );
    console.log(
      "- Day 15: " +
        calculateUnlocked(
          totalAmount,
          startTime,
          endTime,
          15n * 24n * 60n * 60n * 1000n,
        ) +
        " MIST unlocked",
    );
    console.log(
      "- Day 30: " +
        calculateUnlocked(
          totalAmount,
          startTime,
          endTime,
          30n * 24n * 60n * 60n * 1000n,
        ) +
        " MIST unlocked",
    );
  } catch (error) {
    logError(error, "exampleStreamingPaymentFlow");
  }
}

// Run example if called directly
if (require.main === module) {
  exampleStreamingPaymentFlow();
}
