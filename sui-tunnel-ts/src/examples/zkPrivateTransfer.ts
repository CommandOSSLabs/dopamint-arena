/**
 * ZK Private Transfer Example
 *
 * Demonstrates the `zk_verifier` module for private, zero-knowledge verified
 * transfers:
 * - Setting up a circuit registry for different proof types
 * - Building public inputs from on-chain data using scalar helpers
 * - Submitting transfers for verification
 * - Logging verification results for auditability
 *
 * Circuit Types:
 * - balance_transfer: Proves valid transfer without revealing amounts
 * - range_proof: Proves a value is within a range without revealing it
 * - ownership_proof: Proves ownership of an address without revealing private key
 *
 * Note: Actual Groth16 verification requires real proving keys and proofs from
 * a trusted setup. This SDK focuses on the data pipeline.
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { buildTarget, MODULES } from "../config";
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
// CONSTANTS
// ============================================

export const CircuitType = {
  BALANCE_TRANSFER: 0,
  RANGE_PROOF: 1,
  OWNERSHIP_PROOF: 2,
} as const;

export const TransferStatus = {
  PENDING: 0,
  VERIFIED: 1,
  FAILED: 2,
} as const;

// ============================================
// REGISTRY FUNCTIONS
// ============================================

/**
 * Set up a new circuit registry.
 *
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (registry owner)
 * @returns The created registry ID and transaction digest
 */
export async function setupRegistry(
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ registryId: string; digest: string }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();
  const ownerAddress = signer.getPublicKey().toSuiAddress();

  const tx = new Transaction();

  const registry = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ZK_PRIVATE_TRANSFER, "setup_registry"),
    arguments: [tx.pure.address(ownerAddress)],
  });

  tx.transferObjects([registry], tx.pure.address(ownerAddress));

  const result = await signAndExecute(suiClient, tx, signer);
  const registryId = getCreatedObjectId(
    result.objectChanges,
    "CircuitRegistry",
  );

  if (!registryId) {
    throw new Error("Failed to get created CircuitRegistry ID");
  }

  logTransactionResult(result, "Setup Registry");

  return { registryId, digest: result.digest };
}

// ============================================
// INPUT CONSTRUCTION FUNCTIONS
// ============================================

/**
 * Build public inputs for a balance transfer proof.
 * Constructs 3 scalars: sender, receiver, total commitment (96 bytes total).
 *
 * @param sender - Sender address
 * @param receiver - Receiver address
 * @param total - Total amount
 * @returns Concatenated 32-byte scalars
 */
export function buildTransferInputs(
  sender: string,
  receiver: string,
  total: bigint,
): Uint8Array {
  // Mirror the Move logic: address_to_scalar + u64_to_scalar + concat
  const senderBytes = addressToScalar(sender);
  const receiverBytes = addressToScalar(receiver);
  const totalBytes = u64ToScalar(total);

  const result = new Uint8Array(96);
  result.set(senderBytes, 0);
  result.set(receiverBytes, 32);
  result.set(totalBytes, 64);
  return result;
}

/**
 * Build public inputs for a range proof.
 * Constructs 2 scalars: min, max (64 bytes total).
 *
 * @param minValue - Minimum of the range
 * @param maxValue - Maximum of the range
 * @returns Concatenated 32-byte scalars
 */
export function buildRangeProofInputs(
  minValue: bigint,
  maxValue: bigint,
): Uint8Array {
  if (minValue > maxValue) {
    throw new Error("minValue must be <= maxValue");
  }

  const minBytes = u64ToScalar(minValue);
  const maxBytes = u64ToScalar(maxValue);

  const result = new Uint8Array(64);
  result.set(minBytes, 0);
  result.set(maxBytes, 32);
  return result;
}

/**
 * Build public inputs for an ownership proof.
 * Constructs 1 scalar: address (32 bytes).
 *
 * @param addr - The address to prove ownership of
 * @returns 32-byte scalar
 */
export function buildOwnershipProofInputs(addr: string): Uint8Array {
  return addressToScalar(addr);
}

/**
 * Create a commitment hash for a private amount.
 *
 * @param amount - The amount to commit
 * @param blindingFactor - Random blinding factor
 * @returns Blake2b256 hash of the commitment
 */
export function commitAmount(
  amount: bigint,
  blindingFactor: Uint8Array,
): Uint8Array {
  const amountScalar = u64ToScalar(amount);
  const combined = new Uint8Array(amountScalar.length + blindingFactor.length);
  combined.set(amountScalar, 0);
  combined.set(blindingFactor, amountScalar.length);
  return blake2b256(combined);
}

// ============================================
// TRANSFER FUNCTIONS
// ============================================

/**
 * Submit a private transfer for verification.
 *
 * @param receiver - Receiver address
 * @param circuitId - ID of the circuit to verify against
 * @param publicInputs - The public inputs for the proof
 * @param proofBytes - The ZK proof bytes
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (sender)
 * @returns The created transfer ID and transaction digest
 */
export async function submitTransfer(
  receiver: string,
  circuitId: Uint8Array,
  publicInputs: Uint8Array,
  proofBytes: Uint8Array,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ transferId: string; digest: string }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();
  const senderAddress = signer.getPublicKey().toSuiAddress();

  const tx = new Transaction();

  const transfer = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ZK_PRIVATE_TRANSFER, "submit_transfer"),
    arguments: [
      tx.pure.address(senderAddress),
      tx.pure.address(receiver),
      tx.pure.vector("u8", Array.from(circuitId)),
      tx.pure.vector("u8", Array.from(publicInputs)),
      tx.pure.vector("u8", Array.from(proofBytes)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  tx.transferObjects([transfer], tx.pure.address(senderAddress));

  const result = await signAndExecute(suiClient, tx, signer);
  const transferId = getCreatedObjectId(
    result.objectChanges,
    "PrivateTransfer",
  );

  if (!transferId) {
    throw new Error("Failed to get created PrivateTransfer ID");
  }

  logTransactionResult(result, "Submit Transfer");

  return { transferId, digest: result.digest };
}

/**
 * Verify a pending transfer against a circuit registry.
 *
 * @param transferId - The transfer object ID
 * @param registryId - The circuit registry object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function verifyTransfer(
  transferId: string,
  registryId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ZK_PRIVATE_TRANSFER, "verify_transfer"),
    arguments: [
      tx.object(transferId),
      tx.object(registryId),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Verify Transfer");

  return result.digest;
}

/**
 * Create a verification log entry for auditing.
 *
 * @param transferId - The transfer object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns The created log ID and transaction digest
 */
export async function logVerification(
  transferId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ logId: string; digest: string }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();
  const address = signer.getPublicKey().toSuiAddress();

  const tx = new Transaction();

  const log = tx.moveCall({
    target: buildTarget(
      MODULES.EXAMPLE_ZK_PRIVATE_TRANSFER,
      "log_verification",
    ),
    arguments: [tx.object(transferId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  tx.transferObjects([log], tx.pure.address(address));

  const result = await signAndExecute(suiClient, tx, signer);
  const logId = getCreatedObjectId(result.objectChanges, "VerificationLog");

  if (!logId) {
    throw new Error("Failed to get created VerificationLog ID");
  }

  logTransactionResult(result, "Log Verification");

  return { logId, digest: result.digest };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get transfer status as a human-readable string.
 */
export function getTransferStatusName(status: number): string {
  switch (status) {
    case TransferStatus.PENDING:
      return "Pending";
    case TransferStatus.VERIFIED:
      return "Verified";
    case TransferStatus.FAILED:
      return "Failed";
    default:
      return "Unknown";
  }
}

/**
 * Get circuit type as a human-readable string.
 */
export function getCircuitTypeName(circuitType: number): string {
  switch (circuitType) {
    case CircuitType.BALANCE_TRANSFER:
      return "Balance Transfer";
    case CircuitType.RANGE_PROOF:
      return "Range Proof";
    case CircuitType.OWNERSHIP_PROOF:
      return "Ownership Proof";
    default:
      return "Unknown";
  }
}

/**
 * Compute circuit ID from a name (deterministic hash).
 */
export function getCircuitId(name: string): Uint8Array {
  const encoder = new TextEncoder();
  return blake2b256(encoder.encode(name));
}

/**
 * Convert a u64 to a 32-byte scalar (big-endian, zero-padded).
 * Mirrors the Move zk_verifier::u64_to_scalar function.
 */
function u64ToScalar(value: bigint): Uint8Array {
  const result = new Uint8Array(32);
  // Place u64 bytes in big-endian at the end of the 32-byte array
  let v = value;
  for (let i = 31; i >= 24; i--) {
    result[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return result;
}

/**
 * Convert an address to a 32-byte scalar.
 * Mirrors the Move zk_verifier::address_to_scalar function.
 */
function addressToScalar(address: string): Uint8Array {
  const cleanHex = address.startsWith("0x") ? address.slice(2) : address;
  const result = new Uint8Array(32);
  for (let i = 0; i < Math.min(cleanHex.length / 2, 32); i++) {
    result[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16);
  }
  return result;
}

// ============================================
// EXAMPLE USAGE
// ============================================

/**
 * Complete ZK private transfer example flow.
 */
export async function exampleZkPrivateTransferFlow(): Promise<void> {
  console.log("=== ZK Private Transfer Example ===\n");

  try {
    const senderKeypair = getKeypairFromEnv("SENDER_PRIVATE_KEY");
    const client = createSuiClient();

    // Step 1: Set up circuit registry
    console.log("Step 1: Set up circuit registry...");
    // const registryResult = await setupRegistry(client, senderKeypair);
    // console.log(`Registry created: ${registryResult.registryId}\n`);

    // Step 2: Build public inputs for a balance transfer
    console.log("Step 2: Build public inputs...");
    // const inputs = buildTransferInputs("0xSENDER", "0xRECEIVER", 1000n);
    // console.log(`Inputs length: ${inputs.length} bytes\n`);

    // Step 3: Submit transfer
    console.log("Step 3: Submit transfer for verification...");
    // const transferResult = await submitTransfer(
    //   "0xRECEIVER", circuitId, inputs, proofBytes,
    //   client, senderKeypair,
    // );

    // Step 4: Verify transfer
    console.log("Step 4: Verify transfer...");
    // await verifyTransfer(transferResult.transferId, registryResult.registryId, client, senderKeypair);

    // Step 5: Log verification for auditing
    console.log("Step 5: Log verification...");
    // await logVerification(transferResult.transferId, client, senderKeypair);

    console.log("\n=== ZK private transfer flow complete! ===");
    console.log(
      "\nNote: Uncomment the actual calls after setting up keypairs and proof data.",
    );
  } catch (error) {
    logError(error, "exampleZkPrivateTransferFlow");
  }
}

// Run example if called directly
if (require.main === module) {
  exampleZkPrivateTransferFlow();
}
