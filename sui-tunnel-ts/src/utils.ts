/**
 * Utility functions for the Sui Tunnel Framework TypeScript SDK
 */

import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  Transaction,
  TransactionResult as TxResult,
} from "@mysten/sui/transactions";
import { blake2b } from "@noble/hashes/blake2b";
import { getNetwork, SuiNetwork } from "./config";

// ============================================
// CLIENT INITIALIZATION
// ============================================

/**
 * Create a Sui client for the configured network
 */
export function createSuiClient(network?: SuiNetwork): SuiClient {
  const targetNetwork = network || getNetwork();
  const url =
    targetNetwork === "localnet"
      ? "http://127.0.0.1:9000"
      : getFullnodeUrl(targetNetwork);
  return new SuiClient({ url });
}

/**
 * Get keypair from environment variable
 */
export function getKeypairFromEnv(
  envVar: string = "PRIVATE_KEY"
): Ed25519Keypair {
  const privateKey = process.env[envVar];
  if (!privateKey) {
    throw new Error(`${envVar} not found in environment variables`);
  }
  return Ed25519Keypair.fromSecretKey(privateKey);
}

// ============================================
// HASHING UTILITIES
// ============================================

/**
 * Compute Blake2b-256 hash of data
 */
export function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 });
}

/**
 * Compute a commit-reveal commitment hash.
 *
 * Delegates to the canonical, length-prefixed implementation in
 * `core/commitment`, which is byte-identical to `randomness.move`. The previous
 * inline version here hashed `DOMAIN || value || salt` WITHOUT length prefixes
 * and therefore produced commitments that fail `verify_commitment` on-chain.
 */
export { computeCommitment } from "./core/commitment";

/**
 * Compute RPS move commitment
 * commitment = blake2b256([move_byte] || salt)
 */
export function computeRPSCommitment(
  move: number,
  salt: Uint8Array
): Uint8Array {
  const data = new Uint8Array(1 + salt.length);
  data[0] = move;
  data.set(salt, 1);
  return blake2b256(data);
}

/**
 * Generate random salt for commitments
 */
export function generateSalt(length: number = 32): Uint8Array {
  const salt = new Uint8Array(length);
  crypto.getRandomValues(salt);
  return salt;
}

/**
 * Generate random secret for atomic swaps
 */
export function generateSecret(length: number = 32): Uint8Array {
  return generateSalt(length);
}

// ============================================
// ENCODING UTILITIES
// ============================================

/**
 * Convert string to Uint8Array
 */
export function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Convert Uint8Array to string
 */
export function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert address string to bytes (without 0x prefix)
 */
export function addressToBytes(address: string): Uint8Array {
  return hexToBytes(address);
}

// ============================================
// TRANSACTION UTILITIES
// ============================================

/**
 * Sign and execute a transaction
 */
export async function signAndExecute(
  client: SuiClient,
  tx: Transaction,
  keypair: Ed25519Keypair
): Promise<{ digest: string; effects: any; objectChanges: any; events: any }> {
  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
  });

  // Wait for transaction to finalize
  const details = await client.waitForTransaction({
    digest: result.digest,
    options: {
      showEffects: true,
      showObjectChanges: true,
      showEvents: true,
    },
  });

  return {
    digest: result.digest,
    effects: details.effects,
    objectChanges: details.objectChanges,
    events: details.events,
  };
}

/**
 * Get the ID of a created object from transaction effects
 */
export function getCreatedObjectId(
  objectChanges: any[],
  objectType?: string
): string | null {
  if (!objectChanges) return null;

  for (const change of objectChanges) {
    if (change.type === "created") {
      if (!objectType || change.objectType?.includes(objectType)) {
        return change.objectId;
      }
    }
  }
  return null;
}

/**
 * Get multiple created object IDs from transaction effects
 */
export function getCreatedObjectIds(
  objectChanges: any[],
  objectType?: string
): string[] {
  if (!objectChanges) return [];

  return objectChanges
    .filter((change) => {
      if (change.type !== "created") return false;
      if (objectType && !change.objectType?.includes(objectType)) return false;
      return true;
    })
    .map((change) => change.objectId);
}

// ============================================
// COIN UTILITIES
// ============================================

/**
 * Get SUI coins owned by an address
 */
export async function getSuiCoins(
  client: SuiClient,
  address: string
): Promise<Array<{ objectId: string; balance: bigint }>> {
  const coins = await client.getCoins({
    owner: address,
    coinType: "0x2::sui::SUI",
  });

  return coins.data.map((coin) => ({
    objectId: coin.coinObjectId,
    balance: BigInt(coin.balance),
  }));
}

/**
 * Get a coin with sufficient balance
 */
export async function getCoinWithBalance(
  client: SuiClient,
  address: string,
  minBalance: bigint
): Promise<string | null> {
  const coins = await getSuiCoins(client, address);

  for (const coin of coins) {
    if (coin.balance >= minBalance) {
      return coin.objectId;
    }
  }
  return null;
}

/**
 * Split a coin to get exact amount
 */
export function splitCoin(
  tx: Transaction,
  coinId: string,
  amount: bigint
): TxResult {
  return tx.splitCoins(tx.object(coinId), [tx.pure.u64(amount)]);
}

// ============================================
// TIME UTILITIES
// ============================================

/**
 * Get current time in milliseconds
 */
export function now(): bigint {
  return BigInt(Date.now());
}

/**
 * Add duration to current time
 */
export function futureTime(durationMs: bigint): bigint {
  return now() + durationMs;
}

/**
 * Check if a timestamp is in the past
 */
export function isPast(timestamp: bigint): boolean {
  return timestamp < now();
}

/**
 * Check if a timestamp is in the future
 */
export function isFuture(timestamp: bigint): boolean {
  return timestamp > now();
}

/**
 * Format milliseconds as human-readable duration
 */
export function formatDuration(ms: bigint): string {
  const seconds = Number(ms / 1000n);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? "s" : ""}`;
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""}`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""}`;
  return `${seconds} second${seconds !== 1 ? "s" : ""}`;
}

// ============================================
// OBJECT FETCHING UTILITIES
// ============================================

/**
 * Fetch an object by ID
 */
export async function getObject(
  client: SuiClient,
  objectId: string
): Promise<any> {
  const result = await client.getObject({
    id: objectId,
    options: {
      showContent: true,
      showType: true,
      showOwner: true,
    },
  });

  if (result.error) {
    throw new Error(`Failed to fetch object ${objectId}: ${result.error.code}`);
  }

  return result.data;
}

/**
 * Fetch multiple objects by IDs
 */
export async function getObjects(
  client: SuiClient,
  objectIds: string[]
): Promise<any[]> {
  const results = await client.multiGetObjects({
    ids: objectIds,
    options: {
      showContent: true,
      showType: true,
      showOwner: true,
    },
  });

  return results.map((result, index) => {
    if (result.error) {
      throw new Error(
        `Failed to fetch object ${objectIds[index]}: ${result.error.code}`
      );
    }
    return result.data;
  });
}

// ============================================
// VALIDATION UTILITIES
// ============================================

/**
 * Validate that an address is valid
 */
export function isValidAddress(address: string): boolean {
  if (!address.startsWith("0x")) return false;
  if (address.length !== 66) return false; // 0x + 64 hex chars
  return /^0x[a-fA-F0-9]{64}$/.test(address);
}

/**
 * Validate that an object ID is valid
 */
export function isValidObjectId(objectId: string): boolean {
  return isValidAddress(objectId);
}

/**
 * Ensure address has 0x prefix
 */
export function normalizeAddress(address: string): string {
  if (!address.startsWith("0x")) {
    return "0x" + address;
  }
  return address;
}

// ============================================
// LOGGING UTILITIES
// ============================================

/**
 * Log transaction result
 */
export function logTransactionResult(
  result: { digest: string; effects?: any; objectChanges?: any },
  label: string = "Transaction"
): void {
  console.log(`\n${label} Result:`);
  console.log(`  Digest: ${result.digest}`);

  if (result.effects?.status) {
    console.log(`  Status: ${result.effects.status.status}`);
  }

  if (result.objectChanges) {
    const created = result.objectChanges.filter(
      (c: any) => c.type === "created"
    );
    if (created.length > 0) {
      console.log(`  Created Objects:`);
      created.forEach((obj: any) => {
        console.log(`    - ${obj.objectId} (${obj.objectType})`);
      });
    }
  }
}

/**
 * Log error with context
 */
export function logError(error: unknown, context: string): void {
  console.error(`\nError in ${context}:`);
  if (error instanceof Error) {
    console.error(`  Message: ${error.message}`);
    if (error.stack) {
      console.error(
        `  Stack: ${error.stack.split("\n").slice(1, 4).join("\n")}`
      );
    }
  } else {
    console.error(`  ${error}`);
  }
}
