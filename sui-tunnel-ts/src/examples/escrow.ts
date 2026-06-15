/**
 * Escrow Example
 *
 * Demonstrates how to use the example_escrow Move module for:
 * - Creating an escrow between buyer and seller
 * - Marking delivery
 * - Confirming and releasing funds
 * - Raising disputes
 * - Auto-release after timeout
 *
 * Flow:
 * 1. Buyer deposits funds into escrow
 * 2. Seller delivers goods/services
 * 3. Buyer confirms receipt OR raises dispute
 * 4. Escrow settles based on outcome
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import {
  buildTarget,
  DEFAULT_DISPUTE_WINDOW_MS,
  EscrowStatus,
  MODULES,
  SUI_COIN_TYPE,
} from "../config";
import { CreateEscrowResult } from "../types";
import {
  createSuiClient,
  getCreatedObjectId,
  getKeypairFromEnv,
  logError,
  logTransactionResult,
  signAndExecute,
  stringToBytes,
} from "../utils";

// ============================================
// ESCROW FUNCTIONS
// ============================================

/**
 * Create a new escrow
 *
 * @param seller - The seller's address
 * @param description - Description of the goods/services
 * @param paymentCoinId - Object ID of the SUI coin to use as payment
 * @param disputeWindowMs - Optional custom dispute window (defaults to 7 days)
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns The created escrow ID and transaction digest
 *
 * @example
 * ```typescript
 * const result = await createEscrow(
 *   "0x1234...seller_address",
 *   "Laptop purchase - MacBook Pro 16inch",
 *   "0xabcd...coin_id",
 * );
 * console.log("Escrow created:", result.escrowId);
 * ```
 */
export async function createEscrow(
  seller: string,
  description: string,
  paymentCoinId: string,
  disputeWindowMs: bigint = BigInt(DEFAULT_DISPUTE_WINDOW_MS),
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<CreateEscrowResult> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call create_escrow function
  // public fun create_escrow(seller, description, payment, dispute_window_ms, clock, ctx)
  const escrow = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ESCROW, "create_escrow"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.pure.address(seller),
      tx.pure.vector("u8", Array.from(stringToBytes(description))),
      tx.object(paymentCoinId),
      tx.pure.u64(disputeWindowMs),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  // Transfer the escrow to sender (or you could share it)
  tx.transferObjects(
    [escrow],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const escrowId = getCreatedObjectId(result.objectChanges, "Escrow");

  if (!escrowId) {
    throw new Error("Failed to get created Escrow ID");
  }

  logTransactionResult(result, "Create Escrow");

  return {
    escrowId,
    digest: result.digest,
  };
}

/**
 * Seller marks goods/services as delivered
 *
 * @param escrowId - The escrow object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be seller)
 * @returns Transaction digest
 *
 * @example
 * ```typescript
 * await markDelivered("0xescrow_id...");
 * console.log("Marked as delivered!");
 * ```
 */
export async function markDelivered(
  escrowId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call mark_delivered function
  // public fun mark_delivered(escrow, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ESCROW, "mark_delivered"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(escrowId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Mark Delivered");

  return result.digest;
}

/**
 * Buyer confirms receipt and releases funds to seller
 *
 * @param escrowId - The escrow object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be buyer)
 * @returns Transaction digest and the released coin ID
 *
 * @example
 * ```typescript
 * const result = await confirmAndRelease("0xescrow_id...");
 * console.log("Funds released to seller!");
 * ```
 */
export async function confirmAndRelease(
  escrowId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call confirm_and_release function
  // public fun confirm_and_release(escrow: &mut Escrow, ctx: &mut TxContext): (Coin<SUI>, EscrowReceipt)
  const [coin, receipt] = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ESCROW, "confirm_and_release"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(escrowId)],
  });

  // Transfer the coin to the seller (will be fetched from escrow)
  // In practice, you'd transfer to escrow.seller
  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Confirm and Release");

  return {
    digest: result.digest,
    coinId,
  };
}

/**
 * Buyer raises a dispute
 *
 * @param escrowId - The escrow object ID
 * @param reason - Reason for the dispute
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be buyer)
 * @returns Transaction digest
 *
 * @example
 * ```typescript
 * await raiseDispute("0xescrow_id...", "Item not as described - damaged on arrival");
 * ```
 */
export async function raiseDispute(
  escrowId: string,
  reason: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call raise_dispute function
  // public fun raise_dispute(escrow, reason, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ESCROW, "raise_dispute"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(escrowId),
      tx.pure.vector("u8", Array.from(stringToBytes(reason))),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Raise Dispute");

  return result.digest;
}

/**
 * Seller claims funds after dispute window passes (auto-release)
 *
 * @param escrowId - The escrow object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be seller)
 * @returns Transaction digest
 *
 * @example
 * ```typescript
 * // Wait for dispute window to pass...
 * await autoRelease("0xescrow_id...");
 * console.log("Funds auto-released to seller!");
 * ```
 */
export async function autoRelease(
  escrowId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call auto_release function
  // public fun auto_release(escrow, clock, ctx)
  const coin = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ESCROW, "auto_release"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(escrowId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Auto Release");

  return {
    digest: result.digest,
    coinId,
  };
}

/**
 * Seller voluntarily refunds the buyer
 *
 * @param escrowId - The escrow object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be seller)
 * @returns Transaction digest
 *
 * @example
 * ```typescript
 * await refundBuyer("0xescrow_id...");
 * console.log("Buyer refunded!");
 * ```
 */
export async function refundBuyer(
  escrowId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call refund_buyer function
  // public fun refund_buyer(escrow: &mut Escrow, ctx: &mut TxContext): Coin<SUI>
  const coin = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ESCROW, "refund_buyer"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(escrowId)],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Refund Buyer");

  return {
    digest: result.digest,
    coinId,
  };
}

/**
 * Buyer cancels escrow before seller involvement
 *
 * @param escrowId - The escrow object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be buyer)
 * @returns Transaction digest
 *
 * @example
 * ```typescript
 * await cancelEscrow("0xescrow_id...");
 * console.log("Escrow cancelled, funds returned!");
 * ```
 */
export async function cancelEscrow(
  escrowId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call cancel_escrow function
  // public fun cancel_escrow(escrow: &mut Escrow, ctx: &mut TxContext): Coin<SUI>
  const coin = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ESCROW, "cancel_escrow"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(escrowId)],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Cancel Escrow");

  return {
    digest: result.digest,
    coinId,
  };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get escrow status as a human-readable string
 */
export function getEscrowStatusName(status: number): string {
  switch (status) {
    case EscrowStatus.CREATED:
      return "Created";
    case EscrowStatus.FUNDED:
      return "Funded";
    case EscrowStatus.DELIVERED:
      return "Delivered";
    case EscrowStatus.DISPUTED:
      return "Disputed";
    case EscrowStatus.COMPLETED:
      return "Completed";
    case EscrowStatus.REFUNDED:
      return "Refunded";
    case EscrowStatus.CANCELLED:
      return "Cancelled";
    default:
      return "Unknown";
  }
}

// ============================================
// EXAMPLE USAGE
// ============================================

/**
 * Complete escrow flow example
 */
export async function exampleEscrowFlow(): Promise<void> {
  console.log("=== Escrow Example ===\n");

  try {
    // This is a demonstration - in practice you'd have separate keypairs for buyer and seller
    const buyerKeypair = getKeypairFromEnv("BUYER_PRIVATE_KEY");
    const sellerKeypair = getKeypairFromEnv("SELLER_PRIVATE_KEY");
    const client = createSuiClient();

    const sellerAddress = sellerKeypair.getPublicKey().toSuiAddress();

    // Step 1: Buyer creates escrow
    console.log("Step 1: Buyer creates escrow...");
    // Note: You need to get a valid coin ID first
    // const coins = await getSuiCoins(client, buyerKeypair.getPublicKey().toSuiAddress());
    // const coinId = coins[0].objectId;

    // const escrowResult = await createEscrow(
    //   sellerAddress,
    //   "Example product purchase",
    //   coinId,
    //   BigInt(DEFAULT_DISPUTE_WINDOW_MS),
    //   client,
    //   buyerKeypair
    // );
    // console.log(`Escrow created: ${escrowResult.escrowId}\n`);

    // Step 2: Seller marks as delivered
    console.log("Step 2: Seller marks delivery...");
    // await markDelivered(escrowResult.escrowId, client, sellerKeypair);
    // console.log("Delivery marked!\n");

    // Step 3: Buyer confirms and releases
    console.log("Step 3: Buyer confirms receipt...");
    // await confirmAndRelease(escrowResult.escrowId, client, buyerKeypair);
    // console.log("Funds released to seller!\n");

    console.log("=== Escrow flow complete! ===");
    console.log(
      "\nNote: Uncomment the actual calls after setting up keypairs and coin IDs.",
    );
  } catch (error) {
    logError(error, "exampleEscrowFlow");
  }
}

// Run example if called directly
if (require.main === module) {
  exampleEscrowFlow();
}
