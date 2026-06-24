/**
 * Dispute Resolution Example
 *
 * Demonstrates the `referee` module for configurable dispute resolution:
 * - Service level presets (Basic, Standard, Premium)
 * - Opening and resolving dispute cases
 * - Graduated penalties for repeat offenders
 * - Committee-based multi-party voting
 * - Timeout-based auto-resolution
 *
 * Service Levels:
 * - Basic: 24h timeout, no penalties
 * - Standard: 4h timeout, moderate penalties
 * - Premium: 1h timeout, steep penalties, committee arbitration
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { buildTarget, MODULES } from "../config";
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
// CONSTANTS
// ============================================

export const ServiceLevel = {
  BASIC: 0,
  STANDARD: 1,
  PREMIUM: 2,
} as const;

export const CaseStatus = {
  OPEN: 0,
  RESOLVED: 1,
  TIMED_OUT: 2,
} as const;

export const ResolutionMethod = {
  MANUAL_RAISER: 1,
  MANUAL_RESPONDENT: 2,
  SPLIT: 3,
  TIMEOUT: 4,
} as const;

// ============================================
// DISPUTE CASE FUNCTIONS
// ============================================

/**
 * Open a new dispute case.
 *
 * @param caseNumber - Unique identifier for the case
 * @param againstAddress - Address of the party being disputed
 * @param violationType - Type of violation claimed
 * @param evidenceHash - Hash of off-chain evidence
 * @param stateNonce - State nonce at time of dispute
 * @param description - Human-readable description
 * @param serviceLevel - Which service level (BASIC=0, STANDARD=1, PREMIUM=2)
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (raiser)
 * @returns The created case ID and transaction digest
 */
export async function openCase(
  caseNumber: bigint,
  againstAddress: string,
  violationType: number,
  evidenceHash: Uint8Array,
  stateNonce: bigint,
  description: string,
  serviceLevel: number,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ caseId: string; digest: string }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();
  const raiserAddress = signer.getPublicKey().toSuiAddress();

  const tx = new Transaction();

  const disputeCase = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_DISPUTE_RESOLUTION, "open_case"),
    arguments: [
      tx.pure.u64(caseNumber),
      tx.pure.address(raiserAddress),
      tx.pure.address(againstAddress),
      tx.pure.u8(violationType),
      tx.pure.vector("u8", Array.from(evidenceHash)),
      tx.pure.u64(stateNonce),
      tx.pure.vector("u8", Array.from(stringToBytes(description))),
      tx.pure.u8(serviceLevel),
      // respondent_history and clock are also needed
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  tx.transferObjects([disputeCase], tx.pure.address(raiserAddress));

  const result = await signAndExecute(suiClient, tx, signer);
  const caseId = getCreatedObjectId(result.objectChanges, "DisputeCase");

  if (!caseId) {
    throw new Error("Failed to get created DisputeCase ID");
  }

  logTransactionResult(result, "Open Case");

  return { caseId, digest: result.digest };
}

/**
 * Resolve a case in favor of the raiser (party A).
 *
 * @param caseId - The case object ID
 * @param partyAAmount - Amount awarded to party A
 * @param partyBAmount - Amount awarded to party B
 * @param penalty - Penalty applied
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function resolveForRaiser(
  caseId: string,
  partyAAmount: bigint,
  partyBAmount: bigint,
  penalty: bigint,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  tx.moveCall({
    target: buildTarget(
      MODULES.EXAMPLE_DISPUTE_RESOLUTION,
      "resolve_for_raiser",
    ),
    arguments: [
      tx.object(caseId),
      tx.pure.u64(partyAAmount),
      tx.pure.u64(partyBAmount),
      tx.pure.u64(penalty),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Resolve for Raiser");

  return result.digest;
}

/**
 * Resolve a case in favor of the respondent (party B).
 *
 * @param caseId - The case object ID
 * @param partyAAmount - Amount awarded to party A
 * @param partyBAmount - Amount awarded to party B
 * @param penalty - Penalty applied
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function resolveForRespondent(
  caseId: string,
  partyAAmount: bigint,
  partyBAmount: bigint,
  penalty: bigint,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  tx.moveCall({
    target: buildTarget(
      MODULES.EXAMPLE_DISPUTE_RESOLUTION,
      "resolve_for_respondent",
    ),
    arguments: [
      tx.object(caseId),
      tx.pure.u64(partyAAmount),
      tx.pure.u64(partyBAmount),
      tx.pure.u64(penalty),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Resolve for Respondent");

  return result.digest;
}

/**
 * Resolve a case with a split between both parties.
 *
 * @param caseId - The case object ID
 * @param partyAAmount - Amount awarded to party A
 * @param partyBAmount - Amount awarded to party B
 * @param penalty - Penalty applied
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function resolveSplit(
  caseId: string,
  partyAAmount: bigint,
  partyBAmount: bigint,
  penalty: bigint,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_DISPUTE_RESOLUTION, "resolve_split"),
    arguments: [
      tx.object(caseId),
      tx.pure.u64(partyAAmount),
      tx.pure.u64(partyBAmount),
      tx.pure.u64(penalty),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Resolve Split");

  return result.digest;
}

/**
 * Auto-resolve a case after timeout. The raiser wins by default.
 *
 * @param caseId - The case object ID
 * @param totalBalance - Total balance in the disputed tunnel
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function autoResolveTimeout(
  caseId: string,
  totalBalance: bigint,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  tx.moveCall({
    target: buildTarget(
      MODULES.EXAMPLE_DISPUTE_RESOLUTION,
      "auto_resolve_timeout",
    ),
    arguments: [
      tx.object(caseId),
      tx.pure.u64(totalBalance),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Auto Resolve Timeout");

  return result.digest;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get case status as a human-readable string.
 */
export function getCaseStatusName(status: number): string {
  switch (status) {
    case CaseStatus.OPEN:
      return "Open";
    case CaseStatus.RESOLVED:
      return "Resolved";
    case CaseStatus.TIMED_OUT:
      return "Timed Out";
    default:
      return "Unknown";
  }
}

/**
 * Get service level as a human-readable string.
 */
export function getServiceLevelName(level: number): string {
  switch (level) {
    case ServiceLevel.BASIC:
      return "Basic";
    case ServiceLevel.STANDARD:
      return "Standard";
    case ServiceLevel.PREMIUM:
      return "Premium";
    default:
      return "Unknown";
  }
}

/**
 * Get resolution method as a human-readable string.
 */
export function getResolutionMethodName(method: number): string {
  switch (method) {
    case ResolutionMethod.MANUAL_RAISER:
      return "Manual (Raiser)";
    case ResolutionMethod.MANUAL_RESPONDENT:
      return "Manual (Respondent)";
    case ResolutionMethod.SPLIT:
      return "Split";
    case ResolutionMethod.TIMEOUT:
      return "Timeout";
    default:
      return "Unknown";
  }
}

// ============================================
// EXAMPLE USAGE
// ============================================

/**
 * Complete dispute resolution example flow.
 */
export async function exampleDisputeResolutionFlow(): Promise<void> {
  console.log("=== Dispute Resolution Example ===\n");

  try {
    const raiserKeypair = getKeypairFromEnv("PARTY_A_PRIVATE_KEY");
    const client = createSuiClient();

    // Step 1: Open a basic dispute case
    console.log("Step 1: Open a Basic dispute case...");
    // const caseResult = await openCase(
    //   1n, "0xRESPONDENT", 0, new Uint8Array(32), 1n,
    //   "Unresponsive counterparty", ServiceLevel.BASIC,
    //   client, raiserKeypair,
    // );
    // console.log(`Case opened: ${caseResult.caseId}\n`);

    // Step 2: Resolve in favor of raiser
    console.log("Step 2: Resolve in favor of raiser...");
    // await resolveForRaiser(caseResult.caseId, 1000n, 0n, 0n, client, raiserKeypair);

    // Step 3: Open a standard case with penalties
    console.log("Step 3: Open a Standard case (with penalties)...");

    // Step 4: Auto-resolve after timeout
    console.log("Step 4: Auto-resolve after timeout...");
    // await autoResolveTimeout(caseResult.caseId, 1000n, client, raiserKeypair);

    console.log("\n=== Dispute resolution flow complete! ===");
    console.log(
      "\nNote: Uncomment the actual calls after setting up keypairs.",
    );
  } catch (error) {
    logError(error, "exampleDisputeResolutionFlow");
  }
}

// Run example if called directly
if (require.main === module) {
  exampleDisputeResolutionFlow();
}
