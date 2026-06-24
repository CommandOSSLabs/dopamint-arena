/// Module: errors
///
/// Canonical registry of every error raised by the Sui Tunnel Framework, using
/// Move's `#[error]` clever errors: each constant carries a human-readable
/// message that is surfaced on-chain when the abort is decoded.
///
/// `#[error]` is intentionally used without an explicit `code` (the attribute's
/// `code` only accepts a u8, and this framework's taxonomy runs to 809). The
/// canonical numeric code for each error is preserved here in doc comments and
/// the section ranges below for documentation and cross-referencing.
///
/// Move requires an `#[error]` constant to be referenced in the same module
/// that aborts with it, so each functional module (`tunnel`, `signature`,
/// `randomness`, `referee`, `zk_verifier`, `hop`, and the example apps)
/// re-declares the specific errors it uses. This module is the single source of
/// truth for their names, codes, and messages: when adding or changing an
/// error here, mirror it in the module(s) that abort with it (and vice versa).
///
/// Error code ranges (each module has its own code space, so the same code may
/// appear in more than one module with the same meaning):
/// - 0-99:     General errors
/// - 100-199:  Signature errors
/// - 200-299:  Tunnel lifecycle errors
/// - 300-399:  State management errors
/// - 400-499:  Randomness errors
/// - 500-599:  Referee / dispute errors
/// - 600-699:  ZK verification errors
/// - 700-799:  Multi-hop routing errors
/// - 800-899:  Balance / payment errors
/// - 900-999:  Reserved for future use
#[allow(unused_const)]
module sui_tunnel::errors;

// ============================================
// GENERAL ERRORS (0-99)
// ============================================

/// Canonical code 0.
#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

/// Canonical code 1.
#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

/// Canonical code 2.
#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

/// Canonical code 3.
#[error]
const EAlreadyExists: vector<u8> = b"The resource already exists and cannot be created again.";

/// Canonical code 4.
#[error]
const ENotFound: vector<u8> = b"The requested resource was not found.";

/// Canonical code 5.
#[error]
const ENotSupported: vector<u8> = b"The requested operation is not supported.";

/// Canonical code 6.
#[error]
const EInternalError: vector<u8> = b"An internal error occurred.";

/// Canonical code 7.
#[error]
const EOverflow: vector<u8> = b"The operation would cause an arithmetic overflow.";

/// Canonical code 8.
#[error]
const EDivisionByZero: vector<u8> = b"Division by zero is not allowed.";

/// Canonical code 9.
#[error]
const EEmptyInput: vector<u8> = b"Input is empty where a non-empty value was required.";

/// Canonical code 10.
#[error]
const EAlreadyCommitted: vector<u8> = b"A value has already been committed and cannot be committed again.";

/// Canonical code 11.
#[error]
const EAlreadyRevealed: vector<u8> = b"The value has already been revealed and cannot be revealed again.";

/// Canonical code 12.
#[error]
const ENotRevealed: vector<u8> = b"The value has not been revealed yet.";

/// Canonical code 13.
#[error]
const ECommitmentMismatch: vector<u8> = b"The revealed value does not match the original commitment.";

/// Canonical code 14.
#[error]
const EInvalidHash: vector<u8> = b"The hash value is invalid or has the wrong format.";

/// Canonical code 15.
#[error]
const ETimeoutReached: vector<u8> = b"The timeout has already been reached.";

/// Canonical code 16.
#[error]
const EInvalidCommitment: vector<u8> = b"The commitment is invalid or has the wrong format.";

// ============================================
// SIGNATURE ERRORS (100-199)
// ============================================

/// Canonical code 100.
#[error]
const EInvalidSignature: vector<u8> = b"Signature verification failed.";

/// Canonical code 101.
#[error]
const EInvalidPublicKey: vector<u8> = b"The public key is invalid or has the wrong length for its scheme.";

/// Canonical code 102.
#[error]
const EUnsupportedSignatureType: vector<u8> = b"The signature scheme is not supported.";

/// Canonical code 103.
#[error]
const ESignatureExpired: vector<u8> = b"The signature has expired.";

/// Canonical code 104.
#[error]
const ESignatureReplay: vector<u8> = b"The signature has already been used (replay detected).";

/// Canonical code 105.
#[error]
const EInvalidSignatureMessage: vector<u8> = b"The message to be signed is malformed.";

/// Canonical code 106.
#[error]
const EInvalidBlsSignature: vector<u8> = b"BLS signature verification failed.";

/// Canonical code 107.
#[error]
const EInvalidEd25519Signature: vector<u8> = b"Ed25519 signature verification failed.";

/// Canonical code 108.
#[error]
const EInvalidSecp256k1Signature: vector<u8> = b"Secp256k1 signature verification failed.";

/// Canonical code 109.
#[error]
const ESignerNotParty: vector<u8> = b"The signer is not a party to this tunnel.";

// ============================================
// TUNNEL LIFECYCLE ERRORS (200-299)
// ============================================

/// Canonical code 200.
#[error]
const ETunnelClosed: vector<u8> = b"The tunnel is closed or not in the required state for this operation.";

/// Canonical code 201.
#[error]
const ETunnelNotOpen: vector<u8> = b"The tunnel is not open yet.";

/// Canonical code 202.
#[error]
const ETunnelAlreadyOpen: vector<u8> = b"The tunnel has already been opened.";

/// Canonical code 203.
#[error]
const EInvalidTunnelConfig: vector<u8> = b"The tunnel configuration is invalid.";

/// Canonical code 204.
#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

/// Canonical code 205.
#[error]
const ETunnelHasPendingOperations: vector<u8> = b"The tunnel cannot be closed while operations are still pending.";

/// Canonical code 206.
#[error]
const EInvalidTunnelMode: vector<u8> = b"The tunnel mode is invalid for this operation.";

/// Canonical code 207.
#[error]
const ETunnelIdMismatch: vector<u8> = b"The tunnel id does not match the expected tunnel.";

/// Canonical code 208.
#[error]
const EMaxParticipantsExceeded: vector<u8> = b"The maximum number of participants has been exceeded.";

/// Canonical code 209.
#[error]
const EMinParticipantsNotMet: vector<u8> = b"The minimum number of participants has not been met.";

// ============================================
// STATE MANAGEMENT ERRORS (300-399)
// ============================================

/// Canonical code 300.
#[error]
const EInvalidNonce: vector<u8> = b"The nonce is invalid; it must be strictly increasing.";

/// Canonical code 301.
#[error]
const EInvalidVersion: vector<u8> = b"The object version does not match the current module version.";

/// Canonical code 302.
#[error]
const EStateHashMismatch: vector<u8> = b"The state hash does not match the expected value.";

/// Canonical code 303.
#[error]
const EInvalidStateTransition: vector<u8> = b"The requested state transition is not allowed.";

/// Canonical code 304.
#[error]
const EStateAlreadyFinal: vector<u8> = b"The state has already been finalized.";

/// Canonical code 305.
#[error]
const EInvalidStateData: vector<u8> = b"The state data is corrupted or invalid.";

/// Canonical code 306.
#[error]
const EInvalidSequenceNumber: vector<u8> = b"The sequence number is out of order.";

/// Canonical code 307.
#[error]
const EStaleState: vector<u8> = b"The state update was rejected because a newer state already exists.";

/// Canonical code 308.
#[error]
const EMissingStateCommitment: vector<u8> = b"The state commitment is missing.";

/// Canonical code 309.
#[error]
const EStateRollbackNotAllowed: vector<u8> = b"Rolling back to an earlier state is not allowed.";

/// Canonical code 310.
#[error]
const EInvalidTranscriptRoot: vector<u8> = b"The transcript root must be exactly 32 bytes.";

// ============================================
// RANDOMNESS ERRORS (400-499)
// ============================================

/// Canonical code 400.
#[error]
const EInvalidRandomnessSeed: vector<u8> = b"The randomness seed is invalid.";

/// Canonical code 401.
#[error]
const ERandomnessAlreadyRevealed: vector<u8> = b"The randomness has already been revealed.";

/// Canonical code 402.
#[error]
const ERandomnessCommitmentMismatch: vector<u8> = b"The revealed randomness does not match its commitment.";

/// Canonical code 403.
#[error]
const EBlsRandomnessDerivationFailed: vector<u8> = b"Deriving randomness from the BLS signature failed.";

/// Canonical code 404.
#[error]
const ERandomnessNotAvailable: vector<u8> = b"The randomness is not available yet.";

/// Canonical code 405.
#[error]
const EInvalidRandomnessRange: vector<u8> = b"The requested randomness range is invalid; min must be less than max.";

// ============================================
// REFEREE / DISPUTE ERRORS (500-599)
// ============================================

/// Canonical code 500.
#[error]
const EDisputePeriodNotStarted: vector<u8> = b"The dispute period has not started yet.";

/// Canonical code 501.
#[error]
const EDisputePeriodEnded: vector<u8> = b"The dispute period has already ended.";

/// Canonical code 502.
#[error]
const EDisputeInProgress: vector<u8> = b"A dispute is already in progress.";

/// Canonical code 503.
#[error]
const ENoActiveDispute: vector<u8> = b"There is no active dispute to act on.";

/// Canonical code 504.
#[error]
const ETimeoutNotReached: vector<u8> = b"The timeout has not been reached yet.";

/// Canonical code 505.
#[error]
const ETimeoutAlreadyPassed: vector<u8> = b"The timeout has already passed.";

/// Canonical code 506.
#[error]
const EInvalidDisputeEvidence: vector<u8> = b"The dispute evidence is invalid.";

/// Canonical code 507.
#[error]
const ERefereeNotAuthorized: vector<u8> = b"The referee is not authorized to act on this tunnel.";

/// Canonical code 508.
#[error]
const EInvalidPenaltyAmount: vector<u8> = b"The penalty amount is invalid.";

/// Canonical code 509.
#[error]
const EPartyAlreadyResponded: vector<u8> = b"The party has already responded and cannot be penalized.";

/// Canonical code 510.
#[error]
const EInvalidTimeout: vector<u8> = b"The timeout value is invalid.";

// ============================================
// ZK VERIFICATION ERRORS (600-699)
// ============================================

/// Canonical code 600.
#[error]
const EInvalidZkProof: vector<u8> = b"The zero-knowledge proof is invalid.";

/// Canonical code 601.
#[error]
const EInvalidVerificationKey: vector<u8> = b"The verification key is invalid.";

/// Canonical code 602.
#[error]
const EInvalidPublicInputs: vector<u8> = b"The public inputs to the proof are invalid.";

/// Canonical code 603.
#[error]
const ECircuitNotRegistered: vector<u8> = b"The circuit id is not registered.";

/// Canonical code 604.
#[error]
const EInvalidProofFormat: vector<u8> = b"The proof format is invalid.";

/// Canonical code 605.
#[error]
const ECircuitAlreadyRegistered: vector<u8> = b"A circuit with this id is already registered.";

/// Canonical code 606.
#[error]
const EGroth16VerificationFailed: vector<u8> = b"Groth16 proof verification failed.";

/// Canonical code 607.
#[error]
const EProofExpired: vector<u8> = b"The proof has expired.";

/// Canonical code 608.
#[error]
const ECircuitSchemaMismatch: vector<u8> = b"The proof does not match the circuit schema.";

/// Canonical code 609.
#[error]
const EProofSizeExceeded: vector<u8> = b"The proof exceeds the maximum allowed size.";

// ============================================
// MULTI-HOP ROUTING ERRORS (700-799)
// ============================================

/// Canonical code 700.
#[error]
const EInvalidHop: vector<u8> = b"The hop is invalid.";

/// Canonical code 701.
#[error]
const EInvalidRoute: vector<u8> = b"The route is invalid.";

/// Canonical code 702.
#[error]
const EInvalidPreimage: vector<u8> = b"The HTLC preimage is invalid.";

/// Canonical code 703.
#[error]
const EHtlcExpired: vector<u8> = b"The HTLC has expired.";

/// Canonical code 704.
#[error]
const EHtlcNotExpired: vector<u8> = b"The HTLC has not expired yet.";

/// Canonical code 705.
#[error]
const EHopTunnelsNotConnected: vector<u8> = b"The hop tunnels are not connected.";

/// Canonical code 706.
#[error]
const EAtomicSwapFailed: vector<u8> = b"The atomic swap failed.";

/// Canonical code 707.
#[error]
const EMaxHopsExceeded: vector<u8> = b"The maximum number of hops has been exceeded.";

/// Canonical code 708.
#[error]
const EHopAmountExceedsBalance: vector<u8> = b"The hop amount exceeds the available balance.";

/// Canonical code 709.
#[error]
const EHashLockMismatch: vector<u8> = b"The hash lock does not match the provided preimage.";

// ============================================
// BALANCE / PAYMENT ERRORS (800-899)
// ============================================

/// Canonical code 800.
#[error]
const EInsufficientBalance: vector<u8> = b"Insufficient balance for this operation.";

/// Canonical code 801.
#[error]
const EInvalidDepositAmount: vector<u8> = b"The deposit amount is invalid.";

/// Canonical code 802.
#[error]
const EInvalidWithdrawalAmount: vector<u8> = b"The withdrawal amount is invalid.";

/// Canonical code 803.
#[error]
const EBalanceMismatch: vector<u8> = b"The balance does not match the expected amount after the operation.";

/// Canonical code 804.
#[error]
const EPaymentAlreadyProcessed: vector<u8> = b"The payment has already been processed.";

/// Canonical code 805.
#[error]
const EPaymentExpired: vector<u8> = b"The payment has expired.";

/// Canonical code 806.
#[error]
const EBalanceSumMismatch: vector<u8> = b"The party balances do not sum to the total tunnel balance.";

/// Canonical code 807.
#[error]
const EMinimumDepositNotMet: vector<u8> = b"The deposit is below the required minimum.";

/// Canonical code 808.
#[error]
const EMaximumDepositExceeded: vector<u8> = b"The deposit exceeds the allowed maximum.";

/// Canonical code 809.
#[error]
const EPenaltyExceedsDeposit: vector<u8> = b"The penalty exceeds the available deposit.";
