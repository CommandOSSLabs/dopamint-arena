/**
 * TypeScript types for the Sui Tunnel Framework
 * These types mirror the Move structs defined in the contracts
 */

// ============================================
// CORE TUNNEL TYPES
// ============================================

/**
 * Configuration for a tunnel party
 */
export interface PartyConfig {
  address: string;
  publicKey: Uint8Array;
  signatureType: number;
}

/**
 * State commitment for off-chain state
 */
export interface StateCommitment {
  stateHash: Uint8Array;
  nonce: bigint;
  timestamp: bigint;
}

/**
 * Tunnel object representation
 */
export interface Tunnel {
  id: string;
  version: bigint;
  partyA: PartyConfig;
  partyB: PartyConfig;
  balance: bigint;
  partyADeposit: bigint;
  partyBDeposit: bigint;
  state: StateCommitment;
  status: number;
  createdAt: bigint;
  lastActivity: bigint;
  timeoutMs: bigint;
  penaltyAmount: bigint;
  disputeRaiser: string | null;
  /** Highest disputed nonce plus one; enforces monotonic dispute progress. */
  lastDisputedNonce: bigint;
}

// ============================================
// ESCROW TYPES
// ============================================

/**
 * Escrow object representation
 */
export interface Escrow {
  id: string;
  buyer: string;
  seller: string;
  amount: bigint;
  description: Uint8Array;
  termsHash: Uint8Array;
  status: number;
  createdAt: bigint;
  deliveredAt: bigint;
  disputeWindowMs: bigint;
  autoReleaseAt: bigint;
  disputeReason: Uint8Array;
}

/**
 * Receipt for completed escrow
 */
export interface EscrowReceipt {
  escrowId: Uint8Array;
  buyer: string;
  seller: string;
  amount: bigint;
  status: number;
  completedAt: bigint;
}

// ============================================
// ROCK PAPER SCISSORS TYPES
// ============================================

/**
 * RPS game object representation
 */
export interface RPSGame {
  id: string;
  player1: string;
  player2: string;
  stakeAmount: bigint;
  player1Commit: Uint8Array;
  player2Commit: Uint8Array;
  player1Move: number;
  player2Move: number;
  player1Revealed: boolean;
  player2Revealed: boolean;
  status: number;
  createdAt: bigint;
  commitsAt: bigint;
}

/**
 * Result of an RPS game
 */
export interface GameResult {
  winner: string;
  player1Move: number;
  player2Move: number;
  wasTiebreaker: boolean;
}

// ============================================
// COIN FLIP TYPES
// ============================================

/**
 * Coin flip game object representation
 */
export interface CoinFlipGame {
  id: string;
  player1: string;
  player2: string;
  stakeAmount: bigint;
  status: number;
  winner: string;
  result: number;
}

// ============================================
// STREAMING PAYMENT TYPES
// ============================================

/**
 * Payment stream object representation
 */
export interface PaymentStream {
  id: string;
  sender: string;
  recipient: string;
  totalAmount: bigint;
  withdrawnAmount: bigint;
  startTimeMs: bigint;
  endTimeMs: bigint;
  memo: Uint8Array;
  status: number;
}

/**
 * Receipt for a withdrawal from a stream
 */
export interface WithdrawalReceipt {
  streamId: Uint8Array;
  amount: bigint;
  timestampMs: bigint;
  totalWithdrawn: bigint;
}

/**
 * Receipt for stream cancellation
 */
export interface CancellationReceipt {
  streamId: Uint8Array;
  refundedAmount: bigint;
  recipientReceived: bigint;
  timestampMs: bigint;
}

// ============================================
// AGENT ALLOWANCE TYPES
// ============================================

/**
 * Agent spending allowance object representation
 */
export interface Allowance {
  id: string;
  principal: string;
  payee: string;
  delegate: string | null;
  escrowBalance: bigint;
  ratePerSecond: bigint;
  spendCap: bigint;
  spent: bigint;
  authorizedTotal: bigint;
  expiryMs: bigint;
  status: number;
}

// ============================================
// ATOMIC SWAP TYPES
// ============================================

/**
 * Swap lock object representation
 */
export interface SwapLock {
  id: string;
  locker: string;
  claimer: string;
  amount: bigint;
  secretHash: Uint8Array;
  expiresAt: bigint;
  status: number;
  createdAt: bigint;
}

/**
 * Proof that a swap was completed
 */
export interface SwapReceipt {
  swapId: Uint8Array;
  locker: string;
  claimer: string;
  amount: bigint;
  secret: Uint8Array;
  completedAt: bigint;
}

/**
 * A swap pair linking two swap locks
 */
export interface SwapPair {
  initiatorSwapId: Uint8Array;
  responderSwapId: Uint8Array;
  secretHash: Uint8Array;
  initiator: string;
  responder: string;
}

// ============================================
// DUTCH AUCTION TYPES
// ============================================

/**
 * Dutch auction object representation
 */
export interface DutchAuction {
  id: string;
  seller: string;
  description: Uint8Array;
  itemId: Uint8Array;
  startPrice: bigint;
  endPrice: bigint;
  startTimeMs: bigint;
  endTimeMs: bigint;
  status: number;
  winner: string | null;
  salePrice: bigint;
}

/**
 * Receipt for a successful purchase
 */
export interface PurchaseReceipt {
  auctionId: Uint8Array;
  buyer: string;
  itemId: Uint8Array;
  price: bigint;
  purchasedAt: bigint;
}

/**
 * Receipt for auction settlement
 */
export interface SettlementReceipt {
  auctionId: Uint8Array;
  seller: string;
  status: number;
  amount: bigint;
}

// ============================================
// MULTI-HOP PAYMENT TYPES
// ============================================

/**
 * HTLC object representation
 */
export interface HTLC {
  id: Uint8Array;
  paymentHash: Uint8Array;
  expiryMs: bigint;
  status: number;
  preimage: Uint8Array;
}

/**
 * A single hop in a route
 */
export interface Hop {
  tunnelId: Uint8Array;
  nodeAddress: string;
  index: bigint;
  timeoutMs: bigint;
  fee: bigint;
}

/**
 * A complete payment route
 */
export interface Route {
  hops: Hop[];
  amount: bigint;
  totalFees: bigint;
  status: number;
  createdAt: bigint;
}

/**
 * Fee policy for routing
 */
export interface FeePolicy {
  baseFee: bigint;
  feeRatePpm: bigint;
  minHtlc: bigint;
  maxHtlc: bigint;
  minTimeoutDeltaMs: bigint;
}

// ============================================
// RANDOMNESS TYPES
// ============================================

/**
 * Random seed representation
 */
export interface Seed {
  bytes: Uint8Array;
  counter: bigint;
}

/**
 * Commitment for commit-reveal randomness
 */
export interface Commitment {
  hash: Uint8Array;
  committer: string;
  timestamp: bigint;
}

/**
 * Reveal for commit-reveal randomness
 */
export interface Reveal {
  value: Uint8Array;
  salt: Uint8Array;
}

// ============================================
// REFEREE TYPES
// ============================================

/**
 * Referee configuration
 */
export interface RefereeConfig {
  timeoutMs: bigint;
  penaltyRateBps: bigint;
  minDisputeStake: bigint;
}

/**
 * Dispute object representation
 */
export interface Dispute {
  id: string;
  disputer: string;
  tunnelId: Uint8Array;
  claimedState: Uint8Array;
  evidence: Uint8Array;
  deadline: bigint;
  status: number;
}

/**
 * Vote in a committee decision
 */
export interface Vote {
  voter: string;
  inFavor: boolean;
  reason: Uint8Array;
  timestamp: bigint;
}

// ============================================
// TUNNEL LIFECYCLE TYPES
// ============================================

/**
 * Off-chain micropayment state between two parties
 */
export interface MicropaymentState {
  totalAToB: bigint;
  totalBToA: bigint;
  nonce: bigint;
  memo: Uint8Array;
}

/**
 * Micropayment session wrapping a Tunnel
 */
export interface MicropaymentSession {
  id: string;
  status: number;
  latestState: MicropaymentState;
  minUpdateIntervalMs: bigint;
  lastUpdateAt: bigint;
}

/**
 * Receipt issued after a session closes
 */
export interface SessionReceipt {
  id: string;
  partyAReceived: bigint;
  partyBReceived: bigint;
  finalNonce: bigint;
  closeMethod: number;
}

// ============================================
// DISPUTE RESOLUTION TYPES
// ============================================

/**
 * Dispute case wrapping a referee dispute
 */
export interface DisputeCase {
  id: string;
  serviceLevel: number;
  status: number;
  description: Uint8Array;
}

/**
 * Result of an arbitration
 */
export interface ArbitrationResult {
  caseNumber: bigint;
  winner: string | null;
  partyAAmount: bigint;
  partyBAmount: bigint;
  penaltyAmount: bigint;
  resolutionMethod: number;
}

// ============================================
// ZK PRIVATE TRANSFER TYPES
// ============================================

/**
 * Configuration for a transfer circuit type
 */
export interface TransferCircuitConfig {
  name: Uint8Array;
  circuitType: number;
  numInputs: bigint;
  curveType: number;
  description: Uint8Array;
}

/**
 * Private transfer request
 */
export interface PrivateTransfer {
  id: string;
  sender: string;
  receiver: string;
  circuitId: Uint8Array;
  publicInputs: Uint8Array;
  proofBytes: Uint8Array;
  status: number;
  createdAt: bigint;
  verifiedAt: bigint;
}

/**
 * Verification log entry for auditing
 */
export interface VerificationLog {
  id: string;
  transferId: string;
  circuitId: Uint8Array;
  success: boolean;
  inputsHash: Uint8Array;
  timestamp: bigint;
}

// ============================================
// TRANSACTION RESULT TYPES
// ============================================

/**
 * Result of creating an escrow
 */
export interface CreateEscrowResult {
  escrowId: string;
  digest: string;
}

/**
 * Result of creating a game
 */
export interface CreateGameResult {
  gameId: string;
  digest: string;
}

/**
 * Result of creating a stream
 */
export interface CreateStreamResult {
  streamId: string;
  digest: string;
}

/**
 * Result of creating an agent spending allowance
 */
export interface CreateAllowanceResult {
  allowanceId: string;
  digest: string;
}

/**
 * Result of creating a swap lock
 */
export interface CreateSwapResult {
  swapId: string;
  digest: string;
}

/**
 * Result of creating an auction
 */
export interface CreateAuctionResult {
  auctionId: string;
  digest: string;
}

/**
 * Generic transaction result
 */
export interface TransactionResult {
  digest: string;
  effects?: {
    status: { status: string };
    gasUsed: {
      computationCost: string;
      storageCost: string;
      storageRebate: string;
    };
  };
  objectChanges?: Array<{
    type: string;
    objectType?: string;
    objectId?: string;
  }>;
  events?: Array<{
    type: string;
    parsedJson?: Record<string, unknown>;
  }>;
}
