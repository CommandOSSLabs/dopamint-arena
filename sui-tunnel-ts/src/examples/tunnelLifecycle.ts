/**
 * Tunnel Lifecycle Example
 *
 * Demonstrates the full lifecycle of the core `tunnel` module through a
 * micropayment session scenario:
 * - Opening a session (creates and funds a tunnel)
 * - Building state commitments for off-chain updates
 * - Recording on-chain state updates
 * - Cooperative close (happy path)
 * - Dispute + force close (unhappy path)
 *
 * Flow:
 * 1. Party A opens a session with a deposit
 * 2. Party B joins with their deposit
 * 3. Parties exchange micropayments off-chain (build_state_commitment + sign)
 * 4. Close cooperatively OR raise dispute -> force close
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { buildTarget, MODULES, SUI_COIN_TYPE } from "../config";
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
// STATUS CONSTANTS
// ============================================

export const SessionStatus = {
  ACTIVE: 0,
  CLOSED: 1,
  DISPUTED: 2,
  FORCE_CLOSED: 3,
} as const;

export const DEFAULT_TIMEOUT_MS = 3600000; // 1 hour

// ============================================
// SESSION FUNCTIONS
// ============================================

/**
 * Open a new micropayment session.
 * Party A creates the tunnel and deposits funds.
 *
 * @param partyAPublicKey - Party A's ED25519 public key
 * @param partyBAddress - Party B's address
 * @param partyBPublicKey - Party B's ED25519 public key
 * @param depositCoinId - Object ID of the SUI coin for Party A's deposit
 * @param memo - Session description
 * @param minUpdateIntervalMs - Rate limit for on-chain updates (0 = no limit)
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (Party A)
 * @returns The created session ID and transaction digest
 */
export async function openSession(
  partyAPublicKey: Uint8Array,
  partyBAddress: string,
  partyBPublicKey: Uint8Array,
  depositCoinId: string,
  memo: string,
  minUpdateIntervalMs: bigint = 0n,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<{ sessionId: string; digest: string }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();
  const partyAAddress = signer.getPublicKey().toSuiAddress();

  const tx = new Transaction();

  const session = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_TUNNEL_LIFECYCLE, "open_session"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.pure.address(partyAAddress),
      tx.pure.vector("u8", Array.from(partyAPublicKey)),
      tx.pure.address(partyBAddress),
      tx.pure.vector("u8", Array.from(partyBPublicKey)),
      tx.object(depositCoinId),
      tx.pure.vector("u8", Array.from(stringToBytes(memo))),
      tx.pure.u64(minUpdateIntervalMs),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  tx.transferObjects([session], tx.pure.address(partyAAddress));

  const result = await signAndExecute(suiClient, tx, signer);
  const sessionId = getCreatedObjectId(
    result.objectChanges,
    "MicropaymentSession"
  );

  if (!sessionId) {
    throw new Error("Failed to get created MicropaymentSession ID");
  }

  logTransactionResult(result, "Open Session");

  return { sessionId, digest: result.digest };
}

/**
 * Party B joins an existing session by depositing funds.
 *
 * @param sessionId - The session object ID
 * @param depositCoinId - Object ID of the SUI coin for Party B's deposit
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (Party B)
 * @returns Transaction digest
 */
export async function joinSession(
  sessionId: string,
  depositCoinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_TUNNEL_LIFECYCLE, "join_session"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(sessionId),
      tx.object(depositCoinId),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Join Session");

  return result.digest;
}

/**
 * Record a verified off-chain state update on-chain.
 * This is optional - parties only need to submit the latest state when closing.
 *
 * @param sessionId - The session object ID
 * @param totalAToB - Running total paid from A to B
 * @param totalBToA - Running total paid from B to A
 * @param nonce - New nonce (must be > current)
 * @param sigA - Party A's signature on the state (default: empty)
 * @param sigB - Party B's signature on the state (default: empty)
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function recordStateUpdate(
  sessionId: string,
  totalAToB: bigint,
  totalBToA: bigint,
  nonce: bigint,
  sigA: Uint8Array = new Uint8Array(0),
  sigB: Uint8Array = new Uint8Array(0),
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  tx.moveCall({
    target: buildTarget(
      MODULES.EXAMPLE_TUNNEL_LIFECYCLE,
      "record_state_update"
    ),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(sessionId),
      tx.pure.u64(totalAToB),
      tx.pure.u64(totalBToA),
      tx.pure.u64(nonce),
      tx.pure.vector("u8", Array.from(sigA)),
      tx.pure.vector("u8", Array.from(sigB)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Record State Update");

  return result.digest;
}

/**
 * Close the session cooperatively. Both parties agree on final balances.
 *
 * @param sessionId - The session object ID
 * @param finalBalanceA - Final amount for Party A
 * @param finalBalanceB - Final amount for Party B
 * @param sigA - Party A's signature on the settlement
 * @param sigB - Party B's signature on the settlement
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function closeCooperative(
  sessionId: string,
  finalBalanceA: bigint,
  finalBalanceB: bigint,
  sigA: Uint8Array,
  sigB: Uint8Array,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  const [coinA, coinB, receipt] = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_TUNNEL_LIFECYCLE, "close_cooperative"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(sessionId),
      tx.pure.u64(finalBalanceA),
      tx.pure.u64(finalBalanceB),
      tx.pure.vector("u8", Array.from(sigA)),
      tx.pure.vector("u8", Array.from(sigB)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const address = signer.getPublicKey().toSuiAddress();
  tx.transferObjects([coinA, coinB, receipt], tx.pure.address(address));

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Close Cooperative");

  return result.digest;
}

/**
 * Raise a dispute on the session.
 *
 * @param sessionId - The session object ID
 * @param stateHash - Hash of the disputed state
 * @param nonce - State nonce
 * @param timestamp - Timestamp from when the state was originally co-signed
 * @param otherPartySig - The other party's signature on the state
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function raiseDispute(
  sessionId: string,
  stateHash: Uint8Array,
  nonce: bigint,
  timestamp: bigint,
  otherPartySig: Uint8Array,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // public fun raise_dispute(session, state_hash, nonce, timestamp, other_party_sig, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_TUNNEL_LIFECYCLE, "raise_dispute"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(sessionId),
      tx.pure.vector("u8", Array.from(stateHash)),
      tx.pure.u64(nonce),
      tx.pure.u64(timestamp),
      tx.pure.vector("u8", Array.from(otherPartySig)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Raise Dispute");

  return result.digest;
}

/**
 * Force-close the session after the dispute timeout has passed.
 *
 * @param sessionId - The session object ID
 * @param partyABalance - Final balance for Party A
 * @param partyBBalance - Final balance for Party B
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function forceClose(
  sessionId: string,
  partyABalance: bigint,
  partyBBalance: bigint,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  const [coinA, coinB, receipt] = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_TUNNEL_LIFECYCLE, "force_close"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(sessionId),
      tx.pure.u64(partyABalance),
      tx.pure.u64(partyBBalance),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const address = signer.getPublicKey().toSuiAddress();
  tx.transferObjects([coinA, coinB, receipt], tx.pure.address(address));

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Force Close");

  return result.digest;
}

/**
 * Calculate final balances from deposits and payment totals.
 */
export function calculateFinalBalances(
  depositA: bigint,
  depositB: bigint,
  totalAToB: bigint,
  totalBToA: bigint
): { finalA: bigint; finalB: bigint } {
  const finalA = depositA + totalBToA - totalAToB;
  const finalB = depositB + totalAToB - totalBToA;
  return { finalA, finalB };
}

/**
 * Get session status as a human-readable string.
 */
export function getSessionStatusName(status: number): string {
  switch (status) {
    case SessionStatus.ACTIVE:
      return "Active";
    case SessionStatus.CLOSED:
      return "Closed";
    case SessionStatus.DISPUTED:
      return "Disputed";
    case SessionStatus.FORCE_CLOSED:
      return "Force Closed";
    default:
      return "Unknown";
  }
}

// ============================================
// EXAMPLE USAGE
// ============================================

/**
 * Complete tunnel lifecycle example flow.
 */
export async function exampleTunnelLifecycleFlow(): Promise<void> {
  console.log("=== Tunnel Lifecycle Example ===\n");

  try {
    const partyAKeypair = getKeypairFromEnv("PARTY_A_PRIVATE_KEY");
    const partyBKeypair = getKeypairFromEnv("PARTY_B_PRIVATE_KEY");
    const client = createSuiClient();

    const partyBAddress = partyBKeypair.getPublicKey().toSuiAddress();

    // Step 1: Party A opens a session
    console.log("Step 1: Party A opens a micropayment session...");
    // const sessionResult = await openSession(
    //   partyAKeypair.getPublicKey().toRawBytes(),
    //   partyBAddress,
    //   partyBKeypair.getPublicKey().toRawBytes(),
    //   "0xCOIN_ID",
    //   "Streaming video service",
    //   0n,
    //   client,
    //   partyAKeypair,
    // );
    // console.log(`Session created: ${sessionResult.sessionId}\n`);

    // Step 2: Party B joins
    console.log("Step 2: Party B joins the session...");
    // await joinSession(sessionResult.sessionId, "0xCOIN_ID_B", client, partyBKeypair);

    // Step 3: Off-chain micropayments (build commitments, sign, exchange)
    console.log("Step 3: Parties exchange micropayments off-chain...");
    console.log("  (build_state_commitment -> sign -> exchange signatures)");

    // Step 4a: Cooperative close (happy path)
    console.log("\nStep 4a: Cooperative close...");
    // await closeCooperative(sessionResult.sessionId, 800n, 1200n, sigA, sigB, client, partyAKeypair);

    // Step 4b: OR dispute + force close (unhappy path)
    console.log("Step 4b: OR dispute -> force close...");
    // await raiseDispute(sessionResult.sessionId, stateHash, nonce, sig, client, partyAKeypair);
    // await forceClose(sessionResult.sessionId, 800n, 1200n, client, partyAKeypair);

    console.log("\n=== Tunnel lifecycle flow complete! ===");
    console.log(
      "\nNote: Uncomment the actual calls after setting up keypairs and coin IDs."
    );
  } catch (error) {
    logError(error, "exampleTunnelLifecycleFlow");
  }
}

// Run example if called directly
if (require.main === module) {
  exampleTunnelLifecycleFlow();
}
