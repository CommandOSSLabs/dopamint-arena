/**
 * Dutch Auction Example
 *
 * Demonstrates how to use the example_dutch_auction Move module for:
 * - Creating descending price auctions
 * - Buying at current price
 * - Cancelling/expiring auctions
 *
 * Key Concepts:
 * - Price decreases linearly over time
 * - First buyer to accept wins
 * - Seller sets start price, end price (reserve), and duration
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import {
  AuctionStatus,
  MIN_AUCTION_DURATION_MS,
  MODULES,
  SUI_COIN_TYPE,
  buildTarget,
} from "../config";
import { CreateAuctionResult } from "../types";
import {
  createSuiClient,
  formatDuration,
  getCreatedObjectId,
  getKeypairFromEnv,
  logError,
  logTransactionResult,
  now,
  signAndExecute,
  stringToBytes,
} from "../utils";

// ============================================
// DUTCH AUCTION FUNCTIONS
// ============================================

/**
 * Create a new Dutch auction
 *
 * @param description - Description of the item
 * @param itemId - Unique identifier for the item (e.g., NFT ID)
 * @param startPrice - Starting (maximum) price in MIST
 * @param endPrice - Ending (minimum/reserve) price in MIST
 * @param durationMs - Duration of the auction in milliseconds
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (seller)
 * @returns The created auction ID and transaction digest
 *
 * @example
 * ```typescript
 * // Create 1-hour auction: 100 SUI -> 50 SUI
 * const result = await createAuction(
 *   "Rare NFT #1234",
 *   "0xnft_object_id...",
 *   100_000_000_000n,  // 100 SUI
 *   50_000_000_000n,   // 50 SUI reserve
 *   60n * 60n * 1000n  // 1 hour
 * );
 * console.log("Auction created:", result.auctionId);
 * ```
 */
export async function createAuction(
  description: string,
  itemId: string,
  startPrice: bigint,
  endPrice: bigint,
  durationMs: bigint,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<CreateAuctionResult> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  if (durationMs < BigInt(MIN_AUCTION_DURATION_MS)) {
    throw new Error(
      `Duration must be at least ${formatDuration(
        BigInt(MIN_AUCTION_DURATION_MS),
      )}`,
    );
  }

  if (startPrice <= endPrice) {
    throw new Error("Start price must be greater than end price");
  }

  if (endPrice <= 0n) {
    throw new Error("End price must be greater than 0");
  }

  const tx = new Transaction();

  // Call create_auction function
  // public fun create_auction(description, item_id, start_price, end_price, duration_ms, clock, ctx)
  const auction = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_DUTCH_AUCTION, "create_auction"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.pure.vector("u8", Array.from(stringToBytes(description))),
      tx.pure.vector("u8", Array.from(stringToBytes(itemId))),
      tx.pure.u64(startPrice),
      tx.pure.u64(endPrice),
      tx.pure.u64(durationMs),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  // Share the auction so anyone can buy
  tx.moveCall({
    target: "0x2::transfer::public_share_object",
    typeArguments: [
      `${buildTarget(MODULES.EXAMPLE_DUTCH_AUCTION, "DutchAuction")}<${SUI_COIN_TYPE}>`,
    ],
    arguments: [auction],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  const auctionId = getCreatedObjectId(result.objectChanges, "DutchAuction");

  if (!auctionId) {
    throw new Error("Failed to get created DutchAuction ID");
  }

  logTransactionResult(result, "Create Auction");

  return {
    auctionId,
    digest: result.digest,
  };
}

/**
 * Buy at the current price
 *
 * @param auctionId - The auction object ID
 * @param paymentCoinId - Object ID of SUI coin (must be >= current price)
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (buyer)
 * @returns Transaction digest and purchase receipt
 *
 * @example
 * ```typescript
 * const result = await buy("0xauction_id...", "0xcoin_id...");
 * console.log("Purchased! Price:", result.price);
 * ```
 */
export async function buy(
  auctionId: string,
  paymentCoinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; price: bigint }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call buy function
  // public fun buy(auction, payment, clock, ctx)
  const [receipt, change] = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_DUTCH_AUCTION, "buy"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(auctionId),
      tx.object(paymentCoinId),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  tx.transferObjects(
    [change],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Buy");

  // Parse price from events or receipt
  const price = result.events?.[0]?.parsedJson?.price || 0n;

  return {
    digest: result.digest,
    price: BigInt(price),
  };
}

/**
 * Buy at exact current price (returns change)
 *
 * @param auctionId - The auction object ID
 * @param paymentCoinId - Object ID of SUI coin
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (buyer)
 * @returns Transaction digest, price paid, and change coin ID
 *
 * @example
 * ```typescript
 * const result = await buyExact("0xauction_id...", "0xcoin_id...");
 * console.log("Purchased for:", result.price, "Change:", result.changeCoinId);
 * ```
 */
export async function buyExact(
  auctionId: string,
  paymentCoinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; changeCoinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call buy_exact function
  // public fun buy_exact(auction, payment, clock, ctx)
  const [receipt, change] = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_DUTCH_AUCTION, "buy_exact"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(auctionId),
      tx.object(paymentCoinId),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  tx.transferObjects(
    [change],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const changeCoinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Buy Exact");

  return {
    digest: result.digest,
    changeCoinId,
  };
}

/**
 * Seller withdraws payment after sale
 *
 * @param auctionId - The auction object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be seller)
 * @returns Transaction digest and withdrawn coin ID
 *
 * @example
 * ```typescript
 * const result = await withdrawPayment("0xauction_id...");
 * console.log("Payment withdrawn:", result.coinId);
 * ```
 */
export async function withdrawPayment(
  auctionId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call withdraw_payment function
  // public fun withdraw_payment(auction: &mut DutchAuction, ctx: &mut TxContext): (Coin<SUI>, SettlementReceipt)
  const [coin, receipt] = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_DUTCH_AUCTION, "withdraw_payment"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(auctionId)],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Withdraw Payment");

  return {
    digest: result.digest,
    coinId,
  };
}

/**
 * Mark auction as expired (no sale)
 *
 * @param auctionId - The auction object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be seller)
 * @returns Transaction digest
 *
 * @example
 * ```typescript
 * // After auction ends with no buyers
 * await markExpired("0xauction_id...");
 * ```
 */
export async function markExpired(
  auctionId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call mark_expired function
  // public fun mark_expired(auction, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_DUTCH_AUCTION, "mark_expired"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(auctionId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Mark Expired");

  return result.digest;
}

/**
 * Cancel auction before any sale
 *
 * @param auctionId - The auction object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be seller)
 * @returns Transaction digest
 *
 * @example
 * ```typescript
 * await cancelAuction("0xauction_id...");
 * console.log("Auction cancelled");
 * ```
 */
export async function cancelAuction(
  auctionId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call cancel_auction function
  // public fun cancel_auction(auction: &mut DutchAuction, ctx: &TxContext): SettlementReceipt
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_DUTCH_AUCTION, "cancel_auction"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(auctionId)],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Cancel Auction");

  return result.digest;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Calculate current price at a given time
 */
export function calculatePrice(
  startPrice: bigint,
  endPrice: bigint,
  startTime: bigint,
  endTime: bigint,
  currentTime: bigint,
): bigint {
  if (currentTime <= startTime) return startPrice;
  if (currentTime >= endTime) return endPrice;

  const elapsed = currentTime - startTime;
  const duration = endTime - startTime;
  const priceDrop = startPrice - endPrice;
  const dropped = (priceDrop * elapsed) / duration;

  return startPrice - dropped;
}

/**
 * Get time remaining in the auction
 */
export function timeRemaining(endTime: bigint): bigint {
  const currentTime = now();
  return endTime > currentTime ? endTime - currentTime : 0n;
}

/**
 * Get auction status name from status value
 */
export function getAuctionStatusName(status: number): string {
  switch (status) {
    case AuctionStatus.ACTIVE:
      return "Active";
    case AuctionStatus.SOLD:
      return "Sold";
    case AuctionStatus.EXPIRED:
      return "Expired";
    case AuctionStatus.CANCELLED:
      return "Cancelled";
    default:
      return "Unknown";
  }
}

/**
 * Check if auction is still purchasable
 */
export function isPurchasable(status: number, endTime: bigint): boolean {
  return status === AuctionStatus.ACTIVE && now() < endTime;
}

/**
 * Calculate price drop rate per millisecond
 */
export function priceDropRate(
  startPrice: bigint,
  endPrice: bigint,
  durationMs: bigint,
): bigint {
  return (startPrice - endPrice) / durationMs;
}

// ============================================
// EXAMPLE USAGE
// ============================================

/**
 * Complete Dutch auction flow example
 */
export async function exampleDutchAuctionFlow(): Promise<void> {
  console.log("=== Dutch Auction Example ===\n");

  try {
    console.log("What is a Dutch Auction?");
    console.log("- Price starts high and decreases over time");
    console.log("- First buyer to accept the current price wins");
    console.log("- Encourages quick decisions, fair price discovery\n");

    console.log("Flow:");
    console.log("1. Seller creates auction: start price, end price, duration");
    console.log("2. Price drops linearly from start to end over duration");
    console.log("3. Any buyer can purchase at current price");
    console.log("4. First buyer wins, auction ends");
    console.log("5. Seller withdraws payment (or auction expires)\n");

    console.log("Example Code:");
    console.log(`
// Create auction: 100 SUI -> 50 SUI over 1 hour
const auction = await createAuction(
  "Rare NFT Collection",
  "nft_123",
  100_000_000_000n,  // 100 SUI start
  50_000_000_000n,   // 50 SUI reserve
  60n * 60n * 1000n  // 1 hour
);

// Check current price at any time
const currentPrice = calculatePrice(
  100_000_000_000n,
  50_000_000_000n,
  startTime,
  endTime,
  now()
);
console.log("Current price:", currentPrice);

// Buy at current price (with exact payment and change)
await buyExact(auction.auctionId, myCoinId);

// Seller withdraws payment
await withdrawPayment(auction.auctionId);
`);

    // Demonstrate price calculation
    const startPrice = 100_000_000_000n; // 100 SUI
    const endPrice = 50_000_000_000n; // 50 SUI
    const duration = 60n * 60n * 1000n; // 1 hour
    const startTime = 0n;
    const endTime = duration;

    console.log("\nPrice Schedule (100 SUI -> 50 SUI over 1 hour):");
    const times = [0n, 15n, 30n, 45n, 60n]; // minutes
    for (const minutes of times) {
      const ms = minutes * 60n * 1000n;
      const price = calculatePrice(
        startPrice,
        endPrice,
        startTime,
        endTime,
        ms,
      );
      const sui = Number(price) / 1_000_000_000;
      console.log(`- ${minutes} min: ${sui.toFixed(2)} SUI`);
    }
  } catch (error) {
    logError(error, "exampleDutchAuctionFlow");
  }
}

// Run example if called directly
if (require.main === module) {
  exampleDutchAuctionFlow();
}
