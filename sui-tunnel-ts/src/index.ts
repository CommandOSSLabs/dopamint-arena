/**
 * Sui Tunnel Framework - TypeScript SDK
 *
 * A TypeScript SDK for interacting with the Sui Tunnel Framework smart contracts.
 * This SDK provides type-safe functions to call all example Move modules.
 *
 * @example
 * ```typescript
 * import {
 *   createEscrow,
 *   createRPSGame,
 *   createStream,
 *   createSwapLock,
 *   createAuction,
 * } from "sui-tunnel-ts";
 * ```
 */

// ============================================
// CORE OFF-CHAIN PRIMITIVES (wire format, crypto, commit-reveal)
// ============================================

// Namespaced to avoid collisions with utils' re-exported helpers.
// Usage: `import { core, protocols, sim, telemetry } from "sui-tunnel-ts";`
//        `core.serializeStateUpdate(...)`, `new protocols.PaymentsProtocol()`,
//        `sim.runCluster(...)`, `telemetry.rateReport(...)`
export * as agents from "./agents";
export * as bench from "./bench";
export * as core from "./core";
export * as onchain from "./onchain";
export * as proof from "./proof";
export * as protocols from "./protocol";
export * as recovery from "./recovery";
export * as sim from "./sim";
export * as telemetry from "./telemetry";
export * as zk from "./zk";

// ============================================
// CONFIGURATION
// ============================================

export {
  AllowanceStatus,
  AuctionStatus,
  AUTO_RELEASE_WINDOW_MS,
  buildTarget,
  CoinFlipChoice,
  COMMIT_TIMEOUT_MS,
  // Time constants
  DEFAULT_DISPUTE_WINDOW_MS,
  EscrowStatus,
  getCurrentTimeMs,
  getNetwork,
  getUsdcCoinType,
  HTLCStatus,
  MIN_AUCTION_DURATION_MS,
  MIN_LOCK_TIME_MS,
  MIN_STREAM_DURATION_MS,
  MODULES,
  // Package configuration
  PACKAGE_ID,
  RANDOM_ID,
  REVEAL_TIMEOUT_MS,
  RPSGameStatus,
  RPSMove,
  SignatureType,
  StreamStatus,
  SWAP_TIME_BUFFER_MS,
  SwapStatus,
  // Status constants
  TunnelStatus,
  USDC_COIN_TYPE_MAINNET,
  USDC_COIN_TYPE_TESTNET,
  USDC_DECIMALS,
  validateConfig,
} from "./config";

export type { SuiNetwork } from "./config";

// ============================================
// TYPES
// ============================================

export type {
  // Agent allowance types
  Allowance,
  // Dispute resolution types
  ArbitrationResult,
  CancellationReceipt,
  // Coin flip types
  CoinFlipGame,
  Commitment,
  CreateAllowanceResult,
  CreateAuctionResult,
  // Result types
  CreateEscrowResult,
  CreateGameResult,
  CreateStreamResult,
  CreateSwapResult,
  Dispute,
  DisputeCase,
  // Dutch auction types
  DutchAuction,
  // Escrow types
  Escrow,
  EscrowReceipt,
  FeePolicy,
  GameResult,
  Hop,
  // Multi-hop types
  HTLC,
  // Tunnel lifecycle types
  MicropaymentSession,
  MicropaymentState,
  // Core types
  PartyConfig,
  // Streaming payment types
  PaymentStream,
  // ZK private transfer types
  PrivateTransfer,
  PurchaseReceipt,
  // Referee types
  RefereeConfig,
  Reveal,
  Route,
  // RPS types
  RPSGame,
  // Randomness types
  Seed,
  SessionReceipt,
  SettlementReceipt,
  StateCommitment,
  // Atomic swap types
  SwapLock,
  SwapPair,
  SwapReceipt,
  TransactionResult,
  TransferCircuitConfig,
  Tunnel,
  VerificationLog,
  Vote,
  WithdrawalReceipt,
} from "./types";

// ============================================
// UTILITIES
// ============================================

export {
  addressToBytes,
  // Hashing
  blake2b256,
  bytesToHex,
  bytesToString,
  computeCommitment,
  computeRPSCommitment,
  // Client
  createSuiClient,
  formatDuration,
  futureTime,
  generateSalt,
  generateSecret,
  getCoinWithBalance,
  getCreatedObjectId,
  getCreatedObjectIds,
  getKeypairFromEnv,
  // Objects
  getObject,
  getObjects,
  // Coins
  getSuiCoins,
  hexToBytes,
  isFuture,
  isPast,
  // Validation
  isValidAddress,
  isValidObjectId,
  logError,
  // Logging
  logTransactionResult,
  normalizeAddress,
  // Time
  now,
  // Transaction
  signAndExecute,
  splitCoin,
  // Encoding
  stringToBytes,
} from "./utils";

// ============================================
// ESCROW EXAMPLE
// ============================================

export {
  autoRelease,
  cancelEscrow,
  confirmAndRelease,
  createEscrow,
  exampleEscrowFlow,
  getEscrowStatusName,
  markDelivered,
  raiseDispute,
  refundBuyer,
} from "./examples/escrow";

// ============================================
// ROCK PAPER SCISSORS EXAMPLE
// ============================================

export {
  cancelCommitTimeout,
  claimRevealTimeout,
  commitMove,
  createRPSGame,
  determineWinner,
  exampleRPSFlow,
  generateMoveCommitment,
  getGameStatusName,
  getMoveName,
  joinGame,
  revealMove,
  settleGame,
} from "./examples/rockPaperScissors";

// ============================================
// STREAMING PAYMENT EXAMPLE
// ============================================

export {
  calculateAvailable,
  calculateRate,
  calculateUnlocked,
  cancelStream,
  createStream,
  exampleStreamingPaymentFlow,
  getStreamStatusName,
  topUpStream,
  withdraw,
  withdrawAmount,
} from "./examples/streamingPayment";

// ============================================
// AGENT ALLOWANCE EXAMPLE
// ============================================

export {
  authorizeSpend,
  claim,
  claimWithVoucher,
  computeAvailable,
  computeEntitled,
  createAndShareAllowance,
  exampleAgentAllowanceFlow,
  getAllowanceStatusName,
  increaseCap,
  pauseAllowance,
  resumeAllowance,
  revokeAllowance,
  setDelegate,
  setRate,
  signSpendVoucher,
  topUp,
} from "./examples/agentAllowance";

export type {
  AccrualState,
  CreateAllowanceParams,
} from "./examples/agentAllowance";

// ============================================
// USDC STABLECOIN EXAMPLE
// ============================================

export {
  claimUsdc,
  createUsdcAllowance,
  exampleUsdcStablecoinFlow,
  formatUsdc,
  getUsdcCoins,
  topUpUsdc,
  usdc,
} from "./examples/usdcStablecoin";

// ============================================
// ATOMIC SWAP EXAMPLE
// ============================================

export {
  claimSwap,
  claimWithReceipt,
  computeSecretHash,
  createMatchingSwap,
  createSwapLock,
  exampleAtomicSwapFlow,
  generateSecretAndHash,
  getSwapStatusName,
  isClaimable,
  isRefundable,
  refundExpired,
  timeRemaining as swapTimeRemaining,
} from "./examples/atomicSwap";

// ============================================
// DUTCH AUCTION EXAMPLE
// ============================================

export {
  timeRemaining as auctionTimeRemaining,
  buy,
  buyExact,
  calculatePrice,
  cancelAuction,
  createAuction,
  exampleDutchAuctionFlow,
  getAuctionStatusName,
  isPurchasable,
  markExpired,
  priceDropRate,
  withdrawPayment,
} from "./examples/dutchAuction";

// ============================================
// COIN FLIP EXAMPLE
// ============================================

export {
  cancelTimeout,
  claimNoReveal,
  claimWinnings,
  createCoinFlipGame,
  exampleCoinFlipFlow,
  generateChoiceCommitment,
  getChoiceName,
  joinCoinFlipGame,
  revealChoice,
} from "./examples/coinFlip";

// ============================================
// PAYMENT CHANNEL EXAMPLE
// ============================================

export {
  challengeClose,
  closeChannelCooperative,
  computeStateHash,
  createPayment,
  examplePaymentChannelFlow,
  finalizeClose,
  getChannelStatusName,
  initiateClose,
  joinChannel,
  openChannel,
} from "./examples/paymentChannel";

export type { ChannelState } from "./examples/paymentChannel";

// ============================================
// MULTI-HOP PAYMENT EXAMPLE
// ============================================

export {
  calculateRouteFees,
  calculateTotalAmount,
  claimHTLC,
  createHTLC,
  createInvoice,
  exampleMultiHopPaymentFlow,
  forwardHTLC,
  getHTLCStatusName,
  planRoute,
  refundHTLC,
  validateTimeoutCascade,
} from "./examples/multiHopPayment";

// ============================================
// TUNNEL LIFECYCLE EXAMPLE
// ============================================

export {
  calculateFinalBalances,
  closeCooperative,
  exampleTunnelLifecycleFlow,
  forceClose,
  getSessionStatusName,
  joinSession,
  openSession,
  raiseDispute as raiseSessionDispute,
  recordStateUpdate,
  DEFAULT_TIMEOUT_MS as SESSION_DEFAULT_TIMEOUT_MS,
  SessionStatus,
} from "./examples/tunnelLifecycle";

// ============================================
// DISPUTE RESOLUTION EXAMPLE
// ============================================

export {
  autoResolveTimeout,
  CaseStatus,
  exampleDisputeResolutionFlow,
  getCaseStatusName,
  getResolutionMethodName,
  getServiceLevelName,
  openCase,
  ResolutionMethod,
  resolveForRaiser,
  resolveForRespondent,
  resolveSplit,
  ServiceLevel,
} from "./examples/disputeResolution";

// ============================================
// ZK PRIVATE TRANSFER EXAMPLE
// ============================================

export {
  buildOwnershipProofInputs,
  buildRangeProofInputs,
  buildTransferInputs,
  CircuitType,
  commitAmount,
  exampleZkPrivateTransferFlow,
  getCircuitId,
  getCircuitTypeName,
  getTransferStatusName,
  logVerification,
  setupRegistry,
  submitTransfer,
  TransferStatus,
  verifyTransfer,
} from "./examples/zkPrivateTransfer";

// ============================================
// EXAMPLE RUNNER
// ============================================

/**
 * Run all example flows to demonstrate the SDK
 */
async function runAllExamples(): Promise<void> {
  console.log("╔════════════════════════════════════════╗");
  console.log("║   Sui Tunnel Framework - TypeScript    ║");
  console.log("╚════════════════════════════════════════╝\n");

  const examples = [
    {
      name: "Escrow",
      fn: () => import("./examples/escrow").then((m) => m.exampleEscrowFlow()),
    },
    {
      name: "Rock Paper Scissors",
      fn: () =>
        import("./examples/rockPaperScissors").then((m) => m.exampleRPSFlow()),
    },
    {
      name: "Streaming Payment",
      fn: () =>
        import("./examples/streamingPayment").then((m) =>
          m.exampleStreamingPaymentFlow()
        ),
    },
    {
      name: "Atomic Swap",
      fn: () =>
        import("./examples/atomicSwap").then((m) => m.exampleAtomicSwapFlow()),
    },
    {
      name: "Dutch Auction",
      fn: () =>
        import("./examples/dutchAuction").then((m) =>
          m.exampleDutchAuctionFlow()
        ),
    },
    {
      name: "Coin Flip",
      fn: () =>
        import("./examples/coinFlip").then((m) => m.exampleCoinFlipFlow()),
    },
    {
      name: "Payment Channel",
      fn: () =>
        import("./examples/paymentChannel").then((m) =>
          m.examplePaymentChannelFlow()
        ),
    },
    {
      name: "Multi-Hop Payment",
      fn: () =>
        import("./examples/multiHopPayment").then((m) =>
          m.exampleMultiHopPaymentFlow()
        ),
    },
    {
      name: "Tunnel Lifecycle",
      fn: () =>
        import("./examples/tunnelLifecycle").then((m) =>
          m.exampleTunnelLifecycleFlow()
        ),
    },
    {
      name: "Dispute Resolution",
      fn: () =>
        import("./examples/disputeResolution").then((m) =>
          m.exampleDisputeResolutionFlow()
        ),
    },
    {
      name: "ZK Private Transfer",
      fn: () =>
        import("./examples/zkPrivateTransfer").then((m) =>
          m.exampleZkPrivateTransferFlow()
        ),
    },
    {
      name: "Agent Allowance",
      fn: () =>
        import("./examples/agentAllowance").then((m) =>
          m.exampleAgentAllowanceFlow()
        ),
    },
    {
      name: "USDC Stablecoin",
      fn: () =>
        import("./examples/usdcStablecoin").then((m) =>
          m.exampleUsdcStablecoinFlow()
        ),
    },
  ];

  for (const example of examples) {
    console.log(`\n${"─".repeat(50)}`);
    await example.fn();
    console.log();
  }

  console.log("═".repeat(50));
  console.log("All examples completed!");
  console.log("\nTo run actual transactions, set up your environment:");
  console.log("1. Set PACKAGE_ID to your deployed sui_tunnel package");
  console.log(
    "2. Set PRIVATE_KEY (or BUYER_PRIVATE_KEY, SELLER_PRIVATE_KEY, etc.)"
  );
  console.log("3. Ensure you have SUI tokens for gas and stakes");
}

// Run examples if called directly
if (require.main === module) {
  runAllExamples().catch(console.error);
}
