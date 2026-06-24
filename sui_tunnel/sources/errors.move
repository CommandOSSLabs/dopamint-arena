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

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EAlreadyExists: vector<u8> = b"The resource already exists and cannot be created again.";

#[error]
const ENotFound: vector<u8> = b"The requested resource was not found.";

#[error]
const ENotSupported: vector<u8> = b"The requested operation is not supported.";

#[error]
const EInternalError: vector<u8> = b"An internal error occurred.";

#[error]
const EOverflow: vector<u8> = b"The operation would cause an arithmetic overflow.";

#[error]
const EDivisionByZero: vector<u8> = b"Division by zero is not allowed.";

#[error]
const EEmptyInput: vector<u8> = b"Input is empty where a non-empty value was required.";

#[error]
const EAlreadyCommitted: vector<u8> = b"A value has already been committed and cannot be committed again.";

#[error]
const EAlreadyRevealed: vector<u8> = b"The value has already been revealed and cannot be revealed again.";

#[error]
const ENotRevealed: vector<u8> = b"The value has not been revealed yet.";

#[error]
const ECommitmentMismatch: vector<u8> = b"The revealed value does not match the original commitment.";

#[error]
const EInvalidHash: vector<u8> = b"The hash value is invalid or has the wrong format.";

#[error]
const ETimeoutReached: vector<u8> = b"The timeout has already been reached.";

#[error]
const EInvalidCommitment: vector<u8> = b"The commitment is invalid or has the wrong format.";

#[error]
const EInvalidMove: vector<u8> = b"The submitted move is invalid or out of range.";

// ============================================
// SIGNATURE ERRORS (100-199)
// ============================================

#[error]
const EInvalidSignature: vector<u8> = b"Signature verification failed.";

#[error]
const EInvalidPublicKey: vector<u8> = b"The public key is invalid or has the wrong length for its scheme.";

#[error]
const EUnsupportedSignatureType: vector<u8> = b"The signature scheme is not supported.";

#[error]
const ESignatureExpired: vector<u8> = b"The signature has expired.";

#[error]
const ESignatureReplay: vector<u8> = b"The signature has already been used (replay detected).";

#[error]
const EInvalidSignatureMessage: vector<u8> = b"The message to be signed is malformed.";

#[error]
const EInvalidBlsSignature: vector<u8> = b"BLS signature verification failed.";

#[error]
const EInvalidEd25519Signature: vector<u8> = b"Ed25519 signature verification failed.";

#[error]
const EInvalidSecp256k1Signature: vector<u8> = b"Secp256k1 signature verification failed.";

#[error]
const ESignerNotParty: vector<u8> = b"The signer is not a party to this tunnel.";

// ============================================
// TUNNEL LIFECYCLE ERRORS (200-299)
// ============================================

#[error]
const ETunnelClosed: vector<u8> = b"The tunnel is closed or not in the required state for this operation.";

#[error]
const ETunnelNotOpen: vector<u8> = b"The tunnel is not open yet.";

#[error]
const ETunnelAlreadyOpen: vector<u8> = b"The tunnel has already been opened.";

#[error]
const EInvalidTunnelConfig: vector<u8> = b"The tunnel configuration is invalid.";

#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

#[error]
const ETunnelHasPendingOperations: vector<u8> = b"The tunnel cannot be closed while operations are still pending.";

#[error]
const EInvalidTunnelMode: vector<u8> = b"The tunnel mode is invalid for this operation.";

#[error]
const ETunnelIdMismatch: vector<u8> = b"The tunnel id does not match the expected tunnel.";

#[error]
const EMaxParticipantsExceeded: vector<u8> = b"The maximum number of participants has been exceeded.";

#[error]
const EMinParticipantsNotMet: vector<u8> = b"The minimum number of participants has not been met.";

// ============================================
// STATE MANAGEMENT ERRORS (300-399)
// ============================================

#[error]
const EInvalidNonce: vector<u8> = b"The nonce is invalid; it must be strictly increasing.";

#[error]
const EInvalidVersion: vector<u8> = b"The object version does not match the current module version.";

#[error]
const EStateHashMismatch: vector<u8> = b"The state hash does not match the expected value.";

#[error]
const EInvalidStateTransition: vector<u8> = b"The requested state transition is not allowed.";

#[error]
const EStateAlreadyFinal: vector<u8> = b"The state has already been finalized.";

#[error]
const EInvalidStateData: vector<u8> = b"The state data is corrupted or invalid.";

#[error]
const EInvalidSequenceNumber: vector<u8> = b"The sequence number is out of order.";

#[error]
const EStaleState: vector<u8> = b"The state update was rejected because a newer state already exists.";

#[error]
const EMissingStateCommitment: vector<u8> = b"The state commitment is missing.";

#[error]
const EStateRollbackNotAllowed: vector<u8> = b"Rolling back to an earlier state is not allowed.";

#[error]
const EInvalidTranscriptRoot: vector<u8> = b"The transcript root must be exactly 32 bytes.";

#[error]
const ENotJoined: vector<u8> = b"A required participant has not joined yet.";

// ============================================
// RANDOMNESS ERRORS (400-499)
// ============================================

#[error]
const EInvalidRandomnessSeed: vector<u8> = b"The randomness seed is invalid.";

#[error]
const ERandomnessAlreadyRevealed: vector<u8> = b"The randomness has already been revealed.";

#[error]
const ERandomnessCommitmentMismatch: vector<u8> = b"The revealed randomness does not match its commitment.";

#[error]
const EBlsRandomnessDerivationFailed: vector<u8> = b"Deriving randomness from the BLS signature failed.";

#[error]
const ERandomnessNotAvailable: vector<u8> = b"The randomness is not available yet.";

#[error]
const EInvalidRandomnessRange: vector<u8> = b"The requested randomness range is invalid; min must be less than max.";

// ============================================
// REFEREE / DISPUTE ERRORS (500-599)
// ============================================

#[error]
const EDisputePeriodNotStarted: vector<u8> = b"The dispute period has not started yet.";

#[error]
const EDisputePeriodEnded: vector<u8> = b"The dispute period has already ended.";

#[error]
const EDisputeInProgress: vector<u8> = b"A dispute is already in progress.";

#[error]
const ENoActiveDispute: vector<u8> = b"There is no active dispute to act on.";

#[error]
const ETimeoutNotReached: vector<u8> = b"The timeout has not been reached yet.";

#[error]
const ETimeoutAlreadyPassed: vector<u8> = b"The timeout has already passed.";

#[error]
const EInvalidDisputeEvidence: vector<u8> = b"The dispute evidence is invalid.";

#[error]
const ERefereeNotAuthorized: vector<u8> = b"The referee is not authorized to act on this tunnel.";

#[error]
const EInvalidPenaltyAmount: vector<u8> = b"The penalty amount is invalid.";

#[error]
const EPartyAlreadyResponded: vector<u8> = b"The party has already responded and cannot be penalized.";

#[error]
const EInvalidTimeout: vector<u8> = b"The timeout value is invalid.";

// ============================================
// ZK VERIFICATION ERRORS (600-699)
// ============================================

#[error]
const EInvalidZkProof: vector<u8> = b"The zero-knowledge proof is invalid.";

#[error]
const EInvalidVerificationKey: vector<u8> = b"The verification key is invalid.";

#[error]
const EInvalidPublicInputs: vector<u8> = b"The public inputs to the proof are invalid.";

#[error]
const ECircuitNotRegistered: vector<u8> = b"The circuit id is not registered.";

#[error]
const EInvalidProofFormat: vector<u8> = b"The proof format is invalid.";

#[error]
const ECircuitAlreadyRegistered: vector<u8> = b"A circuit with this id is already registered.";

#[error]
const EGroth16VerificationFailed: vector<u8> = b"Groth16 proof verification failed.";

#[error]
const EProofExpired: vector<u8> = b"The proof has expired.";

#[error]
const ECircuitSchemaMismatch: vector<u8> = b"The proof does not match the circuit schema.";

#[error]
const EProofSizeExceeded: vector<u8> = b"The proof exceeds the maximum allowed size.";

// ============================================
// MULTI-HOP ROUTING ERRORS (700-799)
// ============================================

#[error]
const EInvalidHop: vector<u8> = b"The hop is invalid.";

#[error]
const EInvalidRoute: vector<u8> = b"The route is invalid.";

#[error]
const EInvalidPreimage: vector<u8> = b"The HTLC preimage is invalid.";

#[error]
const EHtlcExpired: vector<u8> = b"The HTLC has expired.";

#[error]
const EHtlcNotExpired: vector<u8> = b"The HTLC has not expired yet.";

#[error]
const EHopTunnelsNotConnected: vector<u8> = b"The hop tunnels are not connected.";

#[error]
const EAtomicSwapFailed: vector<u8> = b"The atomic swap failed.";

#[error]
const EMaxHopsExceeded: vector<u8> = b"The maximum number of hops has been exceeded.";

#[error]
const EHopAmountExceedsBalance: vector<u8> = b"The hop amount exceeds the available balance.";

#[error]
const EHashLockMismatch: vector<u8> = b"The hash lock does not match the provided preimage.";

#[error]
const EHopTunnelMismatch: vector<u8> = b"The hop's tunnel id does not match the provided tunnel.";

#[error]
const ELinkTunnelMismatch: vector<u8> = b"The link's tunnel id does not match the provided tunnel.";

#[error]
const EOutstandingHtlc: vector<u8> = b"The tunnel still has outstanding HTLCs; claim or expire them before destroying.";

#[error]
const EMaxLinksExceeded: vector<u8> = b"The maximum number of links has been exceeded.";

// ============================================
// BALANCE / PAYMENT ERRORS (800-899)
// ============================================

#[error]
const EInsufficientBalance: vector<u8> = b"Insufficient balance for this operation.";

#[error]
const EInvalidDepositAmount: vector<u8> = b"The deposit amount is invalid.";

#[error]
const EInvalidWithdrawalAmount: vector<u8> = b"The withdrawal amount is invalid.";

#[error]
const EBalanceMismatch: vector<u8> = b"The balance does not match the expected amount after the operation.";

#[error]
const EPaymentAlreadyProcessed: vector<u8> = b"The payment has already been processed.";

#[error]
const EPaymentExpired: vector<u8> = b"The payment has expired.";

#[error]
const EBalanceSumMismatch: vector<u8> = b"The party balances do not sum to the total tunnel balance.";

#[error]
const EMinimumDepositNotMet: vector<u8> = b"The deposit is below the required minimum.";

#[error]
const EMaximumDepositExceeded: vector<u8> = b"The deposit exceeds the allowed maximum.";

#[error]
const EPenaltyExceedsDeposit: vector<u8> = b"The penalty exceeds the available deposit.";

#[error]
const ESpendCapExceeded: vector<u8> = b"The spend would exceed the authorized cap.";

#[error]
const ENotYetVested: vector<u8> = b"The amount exceeds the funds vested so far; wait for accrual or submit a higher voucher.";

#[error]
const EStaleAuthorization: vector<u8> = b"The spend authorization is not newer than the current one.";

#[error]
const EPotMismatch: vector<u8> = b"The staked pot does not equal the expected total.";

#[error]
const EMaxRequestsExceeded: vector<u8> = b"The maximum number of requests has been exceeded.";

#[error]
const ETokenLimitExceeded: vector<u8> = b"The total tokens exceed the session token cap.";

#[error]
const ERegressingTotal: vector<u8> = b"The running total cannot regress below the committed total.";
