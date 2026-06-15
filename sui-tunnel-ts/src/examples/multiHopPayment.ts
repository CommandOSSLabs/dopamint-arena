/**
 * Multi-Hop Payment Example
 *
 * Demonstrates how to use the example_multi_hop_payment Move module for:
 * - Creating multi-hop payment routes
 * - Setting up HTLCs across multiple tunnels
 * - Atomic payment settlement
 *
 * Key Concepts:
 * - Payments can route through intermediaries
 * - HTLCs ensure atomic settlement
 * - Cascading timeouts protect all parties
 * - Similar to Lightning Network
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { buildTarget, HTLCStatus, MODULES } from "../config";
import {
  blake2b256,
  createSuiClient,
  generateSecret,
  getCreatedObjectId,
  getKeypairFromEnv,
  logError,
  logTransactionResult,
  now,
  signAndExecute,
} from "../utils";

// ============================================
// MULTI-HOP PAYMENT FUNCTIONS
// ============================================

/**
 * Create a payment invoice (generates secret and hash)
 *
 * @param amount - Amount to be paid
 * @param description - Invoice description
 * @returns Invoice with payment hash and secret
 *
 * @example
 * ```typescript
 * const invoice = createInvoice(1_000_000_000n, "Payment for services");
 * // Share invoice.paymentHash with payer
 * // Keep invoice.secret safe until payment is complete
 * ```
 */
export function createInvoice(
  amount: bigint,
  description: string,
): {
  paymentHash: Uint8Array;
  secret: Uint8Array;
  amount: bigint;
  description: string;
} {
  const secret = generateSecret(32);
  const paymentHash = blake2b256(secret);

  return {
    paymentHash,
    secret,
    amount,
    description,
  };
}

/**
 * Create an HTLC for the first hop
 *
 * @param receiver - Address of the next hop
 * @param amount - Amount to lock
 * @param paymentHash - Hash of the payment secret
 * @param timeLockMs - Time until HTLC expires
 * @param coinId - Object ID of SUI coin to lock
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns The created HTLC ID and transaction digest
 */
export async function createHTLC(
  receiver: string,
  amount: bigint,
  paymentHash: Uint8Array,
  timeLockMs: bigint,
  coinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ htlcId: string; digest: string }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Split coin to exact amount
  const [payment] = tx.splitCoins(tx.object(coinId), [tx.pure.u64(amount)]);

  // Create HTLC
  const htlc = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_MULTI_HOP_PAYMENT, "create_htlc"),
    arguments: [
      tx.pure.address(receiver),
      payment,
      tx.pure.vector("u8", Array.from(paymentHash)),
      tx.pure.u64(timeLockMs),
      tx.pure.u64(now()),
    ],
  });

  // Share the HTLC
  tx.moveCall({
    target: "0x2::transfer::public_share_object",
    typeArguments: [
      `${buildTarget(MODULES.EXAMPLE_MULTI_HOP_PAYMENT, "HTLC")}`,
    ],
    arguments: [htlc],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  const htlcId = getCreatedObjectId(result.objectChanges, "HTLC");

  if (!htlcId) {
    throw new Error("Failed to get created HTLC ID");
  }

  logTransactionResult(result, "Create HTLC");

  return {
    htlcId,
    digest: result.digest,
  };
}

/**
 * Forward an HTLC to the next hop
 *
 * @param receiver - Address of the next hop
 * @param amount - Amount to lock (after deducting fee)
 * @param paymentHash - Same payment hash as previous HTLC
 * @param timeLockMs - Shorter timeout than previous HTLC
 * @param coinId - Object ID of SUI coin to lock
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns The created HTLC ID and transaction digest
 */
export async function forwardHTLC(
  receiver: string,
  amount: bigint,
  paymentHash: Uint8Array,
  timeLockMs: bigint,
  coinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ htlcId: string; digest: string }> {
  // Same as createHTLC but with reduced amount and shorter timeout
  return createHTLC(
    receiver,
    amount,
    paymentHash,
    timeLockMs,
    coinId,
    client,
    keypair,
  );
}

/**
 * Claim an HTLC by revealing the secret
 *
 * @param htlcId - The HTLC object ID
 * @param secret - The preimage of the payment hash
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be receiver)
 * @returns Transaction digest and claimed coin ID
 */
export async function claimHTLC(
  htlcId: string,
  secret: Uint8Array,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  const coin = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_MULTI_HOP_PAYMENT, "claim_htlc"),
    arguments: [
      tx.object(htlcId),
      tx.pure.vector("u8", Array.from(secret)),
      tx.pure.u64(now()),
    ],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Claim HTLC");

  return {
    digest: result.digest,
    coinId,
  };
}

/**
 * Refund an expired HTLC
 *
 * @param htlcId - The HTLC object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be sender)
 * @returns Transaction digest and refunded coin ID
 */
export async function refundHTLC(
  htlcId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  const coin = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_MULTI_HOP_PAYMENT, "refund_htlc"),
    arguments: [tx.object(htlcId), tx.pure.u64(now())],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Refund HTLC");

  return {
    digest: result.digest,
    coinId,
  };
}

// ============================================
// ROUTE PLANNING
// ============================================

/**
 * Plan a payment route through multiple hops
 *
 * @param hops - List of intermediary addresses
 * @param amount - Final amount to reach destination
 * @param feePerHop - Fee charged by each intermediary
 * @param baseTimeoutMs - Base timeout for the last hop
 * @param timeoutDecrement - How much to reduce timeout per hop
 * @returns Planned route with amounts and timeouts for each hop
 */
export function planRoute(
  hops: string[],
  amount: bigint,
  feePerHop: bigint,
  baseTimeoutMs: bigint,
  timeoutDecrement: bigint,
): Array<{ receiver: string; amount: bigint; timeoutMs: bigint }> {
  const route: Array<{ receiver: string; amount: bigint; timeoutMs: bigint }> =
    [];

  // Work backwards from destination
  let currentAmount = amount;
  let currentTimeout = baseTimeoutMs;

  for (let i = hops.length - 1; i >= 0; i--) {
    route.unshift({
      receiver: hops[i],
      amount: currentAmount,
      timeoutMs: currentTimeout,
    });

    // Add fee for the next hop backwards
    currentAmount += feePerHop;
    currentTimeout += timeoutDecrement;
  }

  return route;
}

/**
 * Calculate total fees for a route
 */
export function calculateRouteFees(
  amount: bigint,
  hops: number,
  feePerHop: bigint,
): bigint {
  return feePerHop * BigInt(hops);
}

/**
 * Calculate total amount needed (including fees)
 */
export function calculateTotalAmount(
  amount: bigint,
  hops: number,
  feePerHop: bigint,
): bigint {
  return amount + calculateRouteFees(amount, hops, feePerHop);
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get HTLC status name from status value
 */
export function getHTLCStatusName(status: number): string {
  switch (status) {
    case HTLCStatus.PENDING:
      return "Pending";
    case HTLCStatus.CLAIMED:
      return "Claimed";
    case HTLCStatus.EXPIRED:
      return "Expired";
    case HTLCStatus.REFUNDED:
      return "Refunded";
    default:
      return "Unknown";
  }
}

/**
 * Verify that timeouts cascade correctly
 */
export function validateTimeoutCascade(
  timeouts: bigint[],
  minDifference: bigint,
): boolean {
  for (let i = 1; i < timeouts.length; i++) {
    if (timeouts[i] >= timeouts[i - 1] - minDifference) {
      return false;
    }
  }
  return true;
}

// ============================================
// EXAMPLE USAGE
// ============================================

/**
 * Complete multi-hop payment flow example
 */
export async function exampleMultiHopPaymentFlow(): Promise<void> {
  console.log("=== Multi-Hop Payment Example ===\n");

  try {
    console.log("What is Multi-Hop Payment?");
    console.log("- Send payments through intermediaries");
    console.log("- No direct channel needed between sender and receiver");
    console.log("- HTLCs ensure atomic settlement across all hops");
    console.log("- Similar to Bitcoin's Lightning Network\n");

    console.log("Flow:");
    console.log("1. Receiver creates invoice (generates secret)");
    console.log("2. Sender plans route: Sender -> Bob -> Carol -> Receiver");
    console.log("3. Sender creates HTLC to Bob (longest timeout)");
    console.log("4. Bob creates HTLC to Carol (shorter timeout)");
    console.log("5. Carol creates HTLC to Receiver (shortest timeout)");
    console.log("6. Receiver reveals secret to claim Carol's HTLC");
    console.log("7. Carol uses secret to claim Bob's HTLC");
    console.log("8. Bob uses secret to claim Sender's HTLC");
    console.log("9. Payment complete!\n");

    console.log("Timeout Cascade:");
    console.log("- Each hop has shorter timeout than previous");
    console.log("- Ensures receiver claims first, then cascade back");
    console.log("- If any hop fails, funds are refunded after timeout\n");

    console.log("Example Code:");
    console.log(`
// === Receiver creates invoice ===
const invoice = createInvoice(100_000_000_000n, "Payment for services");
console.log("Payment hash:", bytesToHex(invoice.paymentHash));
// Share payment hash with sender

// === Sender plans route ===
const route = planRoute(
  [bobAddress, carolAddress, receiverAddress],
  100_000_000_000n,  // 100 SUI to receiver
  1_000_000_000n,    // 1 SUI fee per hop
  60n * 60n * 1000n, // 1 hour base timeout
  10n * 60n * 1000n  // 10 min decrement per hop
);

// Total: 100 + (3 * 1) = 103 SUI
// Timeouts: 80min -> 70min -> 60min

// === Sender creates first HTLC ===
const htlc1 = await createHTLC(
  bobAddress,
  route[0].amount,
  invoice.paymentHash,
  route[0].timeoutMs,
  senderCoinId
);

// === Bob forwards to Carol ===
const htlc2 = await forwardHTLC(
  carolAddress,
  route[1].amount,
  invoice.paymentHash,
  route[1].timeoutMs,
  bobCoinId,
  client,
  bobKeypair
);

// === Carol forwards to Receiver ===
const htlc3 = await forwardHTLC(
  receiverAddress,
  route[2].amount,
  invoice.paymentHash,
  route[2].timeoutMs,
  carolCoinId,
  client,
  carolKeypair
);

// === Receiver claims with secret ===
await claimHTLC(htlc3.htlcId, invoice.secret, client, receiverKeypair);
// This reveals the secret on-chain!

// === Carol claims with revealed secret ===
await claimHTLC(htlc2.htlcId, invoice.secret, client, carolKeypair);

// === Bob claims with secret ===
await claimHTLC(htlc1.htlcId, invoice.secret, client, bobKeypair);

// === Payment complete! ===
`);

    // Demonstrate route planning
    console.log("\nRoute Planning Example:");
    const route = planRoute(["Bob", "Carol", "Dave"], 100n, 1n, 60n, 10n);

    console.log("Sending 100 to Dave via Bob and Carol:");
    route.forEach((hop, i) => {
      console.log(
        `  Hop ${i + 1}: -> ${hop.receiver}, amount: ${hop.amount}, timeout: ${
          hop.timeoutMs
        }`,
      );
    });

    console.log(`\nTotal fees: ${calculateRouteFees(100n, 3, 1n)}`);
    console.log(`Total to send: ${calculateTotalAmount(100n, 3, 1n)}`);
  } catch (error) {
    logError(error, "exampleMultiHopPaymentFlow");
  }
}

// Run example if called directly
if (require.main === module) {
  exampleMultiHopPaymentFlow();
}
