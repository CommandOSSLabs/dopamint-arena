/**
 * Payment Channel Example
 *
 * Demonstrates how to use the example_payment_channel Move module for:
 * - Opening bidirectional payment channels
 * - Making off-chain payments
 * - Cooperative and unilateral channel closing
 * - Dispute handling
 *
 * Key Concepts:
 * - Parties deposit funds into the channel
 * - Unlimited off-chain payments between parties
 * - Only opening and closing touch the blockchain
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { buildTarget, MODULES, SUI_COIN_TYPE, TunnelStatus } from "../config";
import {
  blake2b256,
  createSuiClient,
  getCreatedObjectId,
  getKeypairFromEnv,
  logError,
  logTransactionResult,
  signAndExecute,
} from "../utils";

// ============================================
// PAYMENT CHANNEL FUNCTIONS
// ============================================

/**
 * Open a new payment channel
 *
 * @param counterparty - Address of the other party
 * @param depositCoinId - Object ID of SUI coin to deposit
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns The created channel ID and transaction digest
 *
 * @example
 * ```typescript
 * const channel = await openChannel(
 *   "0x1234...counterparty_address",
 *   "0xabcd...coin_id"
 * );
 * console.log("Channel opened:", channel.channelId);
 * ```
 */
export async function openChannel(
  counterparty: string,
  depositCoinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<{ channelId: string; digest: string }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // public fun create_channel(party_b, initial_deposit, ctx)
  const channel = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_PAYMENT_CHANNEL, "create_channel"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.pure.address(counterparty), tx.object(depositCoinId)],
  });

  // Share the channel
  tx.moveCall({
    target: "0x2::transfer::public_share_object",
    typeArguments: [
      `${buildTarget(
        MODULES.EXAMPLE_PAYMENT_CHANNEL,
        "PaymentChannel"
      )}<${SUI_COIN_TYPE}>`,
    ],
    arguments: [channel],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  const channelId = getCreatedObjectId(result.objectChanges, "PaymentChannel");

  if (!channelId) {
    throw new Error("Failed to get created PaymentChannel ID");
  }

  logTransactionResult(result, "Open Channel");

  return {
    channelId,
    digest: result.digest,
  };
}

/**
 * Counterparty joins the channel with their deposit
 *
 * @param channelId - The channel object ID
 * @param depositCoinId - Object ID of SUI coin to deposit
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function joinChannel(
  channelId: string,
  depositCoinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_PAYMENT_CHANNEL, "join_channel"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(channelId), tx.object(depositCoinId)],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Join Channel");

  return result.digest;
}

/**
 * Close channel cooperatively (both parties agree on final balances)
 *
 * @param channelId - The channel object ID
 * @param finalBalanceA - Final balance for party A
 * @param finalBalanceB - Final balance for party B
 * @param signatureA - Party A's signature on the final state
 * @param signatureB - Party B's signature on the final state
 * @param publicKeyA - Party A's public key
 * @param publicKeyB - Party B's public key
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function closeChannelCooperative(
  channelId: string,
  finalBalanceA: bigint,
  finalBalanceB: bigint,
  signatureA: Uint8Array,
  signatureB: Uint8Array,
  publicKeyA: Uint8Array,
  publicKeyB: Uint8Array,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<{ digest: string }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // public fun cooperative_close(channel, balance_a, balance_b, sig_a, sig_b, pk_a, pk_b, ctx)
  const [coinA, coinB] = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_PAYMENT_CHANNEL, "cooperative_close"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(channelId),
      tx.pure.u64(finalBalanceA),
      tx.pure.u64(finalBalanceB),
      tx.pure.vector("u8", Array.from(signatureA)),
      tx.pure.vector("u8", Array.from(signatureB)),
      tx.pure.vector("u8", Array.from(publicKeyA)),
      tx.pure.vector("u8", Array.from(publicKeyB)),
    ],
  });

  tx.transferObjects(
    [coinA, coinB],
    tx.pure.address(signer.getPublicKey().toSuiAddress())
  );

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Close Channel (Cooperative)");

  return { digest: result.digest };
}

/**
 * Initiate closing the channel (starts dispute period)
 *
 * @param channelId - The channel object ID
 * @param nonce - State nonce
 * @param balanceA - Claimed balance for party A
 * @param balanceB - Claimed balance for party B
 * @param signatureA - Party A's signature on the state
 * @param signatureB - Party B's signature on the state
 * @param publicKeyA - Party A's public key
 * @param publicKeyB - Party B's public key
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function initiateClose(
  channelId: string,
  nonce: bigint,
  balanceA: bigint,
  balanceB: bigint,
  signatureA: Uint8Array,
  signatureB: Uint8Array,
  publicKeyA: Uint8Array,
  publicKeyB: Uint8Array,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // public fun initiate_close(channel, nonce, balance_a, balance_b, sig_a, sig_b, pk_a, pk_b, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_PAYMENT_CHANNEL, "initiate_close"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(channelId),
      tx.pure.u64(nonce),
      tx.pure.u64(balanceA),
      tx.pure.u64(balanceB),
      tx.pure.vector("u8", Array.from(signatureA)),
      tx.pure.vector("u8", Array.from(signatureB)),
      tx.pure.vector("u8", Array.from(publicKeyA)),
      tx.pure.vector("u8", Array.from(publicKeyB)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Initiate Close");

  return result.digest;
}

/**
 * Challenge a pending close with a newer state
 *
 * @param channelId - The channel object ID
 * @param nonce - Nonce of the newer state (must be > current nonce)
 * @param balanceA - Balance for party A in newer state
 * @param balanceB - Balance for party B in newer state
 * @param signatureA - Party A's signature on the newer state
 * @param signatureB - Party B's signature on the newer state
 * @param publicKeyA - Party A's public key
 * @param publicKeyB - Party B's public key
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function challengeClose(
  channelId: string,
  nonce: bigint,
  balanceA: bigint,
  balanceB: bigint,
  signatureA: Uint8Array,
  signatureB: Uint8Array,
  publicKeyA: Uint8Array,
  publicKeyB: Uint8Array,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // public fun challenge_close(channel, nonce, balance_a, balance_b, sig_a, sig_b, pk_a, pk_b, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_PAYMENT_CHANNEL, "challenge_close"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(channelId),
      tx.pure.u64(nonce),
      tx.pure.u64(balanceA),
      tx.pure.u64(balanceB),
      tx.pure.vector("u8", Array.from(signatureA)),
      tx.pure.vector("u8", Array.from(signatureB)),
      tx.pure.vector("u8", Array.from(publicKeyA)),
      tx.pure.vector("u8", Array.from(publicKeyB)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Challenge Close");

  return result.digest;
}

/**
 * Finalize channel close after dispute period has passed
 *
 * @param channelId - The channel object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function finalizeClose(
  channelId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<{ digest: string }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // public fun finalize_close(channel, clock, ctx)
  const [coinA, coinB] = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_PAYMENT_CHANNEL, "finalize_close"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(channelId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  tx.transferObjects(
    [coinA, coinB],
    tx.pure.address(signer.getPublicKey().toSuiAddress())
  );

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Finalize Close");

  return { digest: result.digest };
}

// ============================================
// OFF-CHAIN STATE MANAGEMENT
// ============================================

/**
 * Represents an off-chain payment channel state
 */
export interface ChannelState {
  channelId: string;
  balanceA: bigint;
  balanceB: bigint;
  nonce: bigint;
}

/**
 * Compute the state hash for signing
 */
export function computeStateHash(state: ChannelState): Uint8Array {
  const data = new TextEncoder().encode(
    `payment_channel:${state.channelId}:${state.balanceA}:${state.balanceB}:${state.nonce}`
  );
  return blake2b256(data);
}

/**
 * Create an off-chain payment (updates local state)
 *
 * @param state - Current channel state
 * @param amount - Amount to transfer (positive = A to B, negative = B to A)
 * @returns Updated state
 */
export function createPayment(
  state: ChannelState,
  amount: bigint
): ChannelState {
  const newBalanceA = state.balanceA - amount;
  const newBalanceB = state.balanceB + amount;

  if (newBalanceA < 0n || newBalanceB < 0n) {
    throw new Error("Insufficient balance for payment");
  }

  return {
    channelId: state.channelId,
    balanceA: newBalanceA,
    balanceB: newBalanceB,
    nonce: state.nonce + 1n,
  };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get channel status name from status value
 */
export function getChannelStatusName(status: number): string {
  switch (status) {
    case TunnelStatus.CREATED:
      return "Created";
    case TunnelStatus.ACTIVE:
      return "Active";
    case TunnelStatus.CLOSED:
      return "Closed";
    case TunnelStatus.DISPUTED:
      return "Disputed";
    default:
      return "Unknown";
  }
}

// ============================================
// EXAMPLE USAGE
// ============================================

/**
 * Complete payment channel flow example
 */
export async function examplePaymentChannelFlow(): Promise<void> {
  console.log("=== Payment Channel Example ===\n");

  try {
    console.log("What is a Payment Channel?");
    console.log("- Two parties lock funds on-chain");
    console.log("- Unlimited off-chain payments between them");
    console.log("- Only 2 on-chain transactions: open and close\n");

    console.log("Flow:");
    console.log("1. Alice opens channel, deposits 100 SUI");
    console.log("2. Bob joins channel, deposits 100 SUI");
    console.log("3. Off-chain: Alice pays Bob 30 (state: A=70, B=130)");
    console.log("4. Off-chain: Bob pays Alice 10 (state: A=80, B=120)");
    console.log("5. ... unlimited payments ...");
    console.log("6. Close: Alice gets 80 SUI, Bob gets 120 SUI\n");

    console.log("Example Code:");
    console.log(`
// Alice opens channel
const channel = await openChannel(bobAddress, aliceCoinId);

// Bob joins
await joinChannel(channel.channelId, bobCoinId, client, bobKeypair);

// === Off-chain payments ===
let state: ChannelState = {
  channelId: channel.channelId,
  balanceA: 100_000_000_000n,  // 100 SUI
  balanceB: 100_000_000_000n,  // 100 SUI
  nonce: 0n,
};

// Alice pays Bob 30 SUI
state = createPayment(state, 30_000_000_000n);
const stateHash = computeStateHash(state);
// Both parties sign stateHash off-chain

// Bob pays Alice 10 SUI
state = createPayment(state, -10_000_000_000n);
// Sign new state...

// === Close channel ===
await closeChannelCooperative(
  channel.channelId,
  state.balanceA,
  state.balanceB,
  aliceSignature,
  bobSignature,
  alicePublicKey,
  bobPublicKey
);
`);

    // Demonstrate state updates
    console.log("\nState Update Example:");
    let state: ChannelState = {
      channelId: "0x123",
      balanceA: 100n,
      balanceB: 100n,
      nonce: 0n,
    };
    console.log(
      `Initial: A=${state.balanceA}, B=${state.balanceB}, nonce=${state.nonce}`
    );

    state = createPayment(state, 30n);
    console.log(
      `After A pays B 30: A=${state.balanceA}, B=${state.balanceB}, nonce=${state.nonce}`
    );

    state = createPayment(state, -10n);
    console.log(
      `After B pays A 10: A=${state.balanceA}, B=${state.balanceB}, nonce=${state.nonce}`
    );

    state = createPayment(state, 5n);
    console.log(
      `After A pays B 5: A=${state.balanceA}, B=${state.balanceB}, nonce=${state.nonce}`
    );
  } catch (error) {
    logError(error, "examplePaymentChannelFlow");
  }
}

// Run example if called directly
if (require.main === module) {
  examplePaymentChannelFlow();
}
