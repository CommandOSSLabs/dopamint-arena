/**
 * Configuration and constants for the Sui Tunnel Framework TypeScript SDK
 */

import { SUI_TYPE_ARG } from "@mysten/sui/utils";
import dotenv from "dotenv";
dotenv.config();

// ============================================
// PACKAGE CONFIGURATION
// ============================================

/**
 * The deployed package ID for sui_tunnel
 * Set this via environment variable or update directly
 */
export const PACKAGE_ID = process.env.PACKAGE_ID || "";

/**
 * The module names in the sui_tunnel package
 */
export const MODULES = {
  ERRORS: "errors",
  SIGNATURE: "signature",
  TUNNEL: "tunnel",
  RANDOMNESS: "randomness",
  SUI_RANDOMNESS: "sui_randomness",
  REFEREE: "referee",
  ZK_VERIFIER: "zk_verifier",
  HOP: "hop",
  // Example modules
  EXAMPLE_ESCROW: "example_escrow",
  EXAMPLE_PAYMENT_CHANNEL: "example_payment_channel",
  EXAMPLE_COIN_FLIP: "example_coin_flip",
  EXAMPLE_ROCK_PAPER_SCISSORS: "example_rock_paper_scissors",
  EXAMPLE_STREAMING_PAYMENT: "example_streaming_payment",
  EXAMPLE_ATOMIC_SWAP: "example_atomic_swap",
  EXAMPLE_DUTCH_AUCTION: "example_dutch_auction",
  EXAMPLE_MULTI_HOP_PAYMENT: "example_multi_hop_payment",
  EXAMPLE_TUNNEL_LIFECYCLE: "example_tunnel_lifecycle",
  EXAMPLE_DISPUTE_RESOLUTION: "example_dispute_resolution",
  EXAMPLE_ZK_PRIVATE_TRANSFER: "example_zk_private_transfer",
  agent_allowance: "agent_allowance",
} as const;

// ============================================
// SYSTEM OBJECTS
// ============================================

/**
 * Sui Random object ID (for on-chain randomness)
 */
export const RANDOM_ID = "0x8";

/**
 * SUI coin type argument for generic Move functions
 */
export const SUI_COIN_TYPE = SUI_TYPE_ARG;

/**
 * Native USDC (Circle) coin types on Sui.
 * Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
 */
export const USDC_COIN_TYPE_MAINNET =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
export const USDC_COIN_TYPE_TESTNET =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";

/** USDC has 6 decimals (1 USDC = 1_000_000 base units). */
export const USDC_DECIMALS = 6;

// ============================================
// NETWORK CONFIGURATION
// ============================================

export type SuiNetwork = "mainnet" | "testnet" | "devnet" | "localnet";

/**
 * Get the network from environment or default to testnet
 */
export function getNetwork(): SuiNetwork {
  const network = process.env.SUI_NETWORK || "testnet";
  if (!["mainnet", "testnet", "devnet", "localnet"].includes(network)) {
    throw new Error(`Invalid network: ${network}`);
  }
  return network as SuiNetwork;
}

/**
 * Resolve the native USDC coin type for a network (defaults to the configured
 * network). devnet/localnet have no canonical USDC, so the testnet type is returned.
 */
export function getUsdcCoinType(network?: SuiNetwork): string {
  const target = network || getNetwork();
  return target === "mainnet" ? USDC_COIN_TYPE_MAINNET : USDC_COIN_TYPE_TESTNET;
}

// ============================================
// STATUS CONSTANTS
// ============================================

/**
 * Tunnel status values (matching Move constants)
 */
export const TunnelStatus = {
  CREATED: 0,
  ACTIVE: 1,
  CLOSED: 2,
  DISPUTED: 3,
} as const;

/**
 * Escrow status values
 */
export const EscrowStatus = {
  CREATED: 0,
  FUNDED: 1,
  DELIVERED: 2,
  DISPUTED: 3,
  COMPLETED: 4,
  REFUNDED: 5,
  CANCELLED: 6,
} as const;

/**
 * RPS game status values
 */
export const RPSGameStatus = {
  WAITING_COMMITS: 0,
  WAITING_REVEALS: 1,
  COMPLETE: 2,
  CANCELLED: 3,
} as const;

/**
 * RPS move values
 */
export const RPSMove = {
  ROCK: 0,
  PAPER: 1,
  SCISSORS: 2,
} as const;

/**
 * Coin flip choice values
 */
export const CoinFlipChoice = {
  HEADS: 0,
  TAILS: 1,
} as const;

/**
 * Payment stream status values
 */
export const StreamStatus = {
  ACTIVE: 0,
  COMPLETED: 1,
  CANCELLED: 2,
} as const;

/**
 * Agent allowance status values (matching agent_allowance Move constants)
 */
export const AllowanceStatus = {
  ACTIVE: 0,
  PAUSED: 1,
  REVOKED: 2,
} as const;

/**
 * Atomic swap status values
 */
export const SwapStatus = {
  LOCKED: 0,
  CLAIMED: 1,
  REFUNDED: 2,
} as const;

/**
 * Dutch auction status values
 */
export const AuctionStatus = {
  ACTIVE: 0,
  SOLD: 1,
  EXPIRED: 2,
  CANCELLED: 3,
} as const;

/**
 * HTLC status values
 */
export const HTLCStatus = {
  PENDING: 0,
  CLAIMED: 1,
  EXPIRED: 2,
  REFUNDED: 3,
} as const;

/**
 * Signature types (matching Move constants)
 */
export const SignatureType = {
  ED25519: 0,
  BLS12381_MIN_SIG: 1,
  BLS12381_MIN_PK: 2,
  SECP256K1: 3,
} as const;

// ============================================
// TIME CONSTANTS
// ============================================

/**
 * Default dispute window (7 days in milliseconds)
 */
export const DEFAULT_DISPUTE_WINDOW_MS = 604800000;

/**
 * Auto-release window (30 days in milliseconds)
 */
export const AUTO_RELEASE_WINDOW_MS = 2592000000;

/**
 * Minimum stream duration (1 hour in milliseconds)
 */
export const MIN_STREAM_DURATION_MS = 3600000;

/**
 * Minimum lock time for atomic swaps (1 hour in milliseconds)
 */
export const MIN_LOCK_TIME_MS = 3600000;

/**
 * Time buffer between atomic swap locks (30 minutes in milliseconds)
 */
export const SWAP_TIME_BUFFER_MS = 1800000;

/**
 * Commit timeout for RPS (5 minutes in milliseconds)
 */
export const COMMIT_TIMEOUT_MS = 300000;

/**
 * Reveal timeout for RPS (5 minutes in milliseconds)
 */
export const REVEAL_TIMEOUT_MS = 300000;

/**
 * Minimum auction duration (10 minutes in milliseconds)
 */
export const MIN_AUCTION_DURATION_MS = 600000;

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Build a Move call target string
 */
export function buildTarget(module: string, func: string): string {
  // Prefer the load-time constant; fall back to the current env (set after load).
  const pkg = PACKAGE_ID || process.env.PACKAGE_ID || "";
  if (!pkg) {
    throw new Error(
      "PACKAGE_ID not set. Please set it in environment variables or config."
    );
  }
  return `${pkg}::${module}::${func}`;
}

/**
 * Get current timestamp in milliseconds
 */
export function getCurrentTimeMs(): number {
  return Date.now();
}

/**
 * Validate that package ID is set
 */
export function validateConfig(): void {
  if (!PACKAGE_ID) {
    throw new Error(
      "PACKAGE_ID is not configured. Please set the PACKAGE_ID environment variable."
    );
  }
}
