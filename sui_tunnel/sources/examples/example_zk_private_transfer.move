/// Example: ZK Private Transfer
///
/// Demonstrates the `zk_verifier` module for private, zero-knowledge verified
/// transfers. Shows how to:
///
/// 1. Set up a circuit registry for different proof types
/// 2. Build public inputs from on-chain data using scalar helpers
/// 3. Verify proofs against registered circuits
/// 4. Log verification results for auditability
///
/// ## Circuit Types:
/// - `balance_transfer`: Proves a transfer is valid without revealing amounts
/// - `range_proof`: Proves a value is within a range without revealing it
/// - `ownership_proof`: Proves ownership of an address without revealing it
///
/// ## Note:
/// Actual Groth16 verification requires real proving keys and proofs from a
/// trusted setup. This example focuses on the data pipeline: registry
/// management, public input construction, and verification result tracking.
module sui_tunnel::example_zk_private_transfer;

use sui::clock::Clock;
use sui::event;
use sui::hash;
use sui_tunnel::zk_verifier;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EEmptyInput: vector<u8> = b"Input is empty where a non-empty value was required.";

#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

// ============================================
// CONSTANTS
// ============================================

/// Circuit type: Balance transfer
const CIRCUIT_BALANCE_TRANSFER: u8 = 0;

/// Circuit type: Range proof
const CIRCUIT_RANGE_PROOF: u8 = 1;

/// Circuit type: Ownership proof
const CIRCUIT_OWNERSHIP_PROOF: u8 = 2;

/// Transfer status: Pending verification
const TRANSFER_PENDING: u8 = 0;

/// Transfer status: Verified
const TRANSFER_VERIFIED: u8 = 1;

/// Transfer status: Failed verification
const TRANSFER_FAILED: u8 = 2;

// ============================================
// STRUCTS
// ============================================

/// Configuration for a transfer circuit type.
/// Describes what inputs a circuit expects and how to interpret them.
public struct TransferCircuitConfig has copy, drop, store {
    /// Human-readable circuit name
    name: vector<u8>,
    /// Which circuit type this is
    circuit_type: u8,
    /// Number of public inputs required
    num_inputs: u64,
    /// Curve type (BLS12-381 or BN254)
    curve_type: u8,
    /// Description of what this circuit proves
    description: vector<u8>,
}

/// Represents a private transfer request.
/// The actual transfer amounts are hidden in the ZK proof.
public struct PrivateTransfer has key, store {
    id: UID,
    /// Sender address (public)
    sender: address,
    /// Receiver address (public)
    receiver: address,
    /// Circuit ID used for verification
    circuit_id: vector<u8>,
    /// Public inputs for the proof
    public_inputs: vector<u8>,
    /// The proof bytes
    proof_bytes: vector<u8>,
    /// Transfer status
    status: u8,
    /// Timestamp
    created_at: u64,
    /// Verification timestamp (0 if not verified)
    verified_at: u64,
}

/// Log entry for verification attempts, useful for auditing.
public struct VerificationLog has key, store {
    id: UID,
    /// The transfer ID
    transfer_id: ID,
    /// Circuit ID used
    circuit_id: vector<u8>,
    /// Whether verification succeeded
    success: bool,
    /// Hash of the public inputs
    inputs_hash: vector<u8>,
    /// Timestamp of verification attempt
    timestamp: u64,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a private transfer is submitted
public struct TransferSubmitted has copy, drop {
    transfer_id: ID,
    sender: address,
    receiver: address,
    circuit_id: vector<u8>,
}

/// Emitted when a transfer is verified
public struct TransferVerified has copy, drop {
    transfer_id: ID,
    success: bool,
    timestamp: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS FOR CONSTANTS
// ============================================

public fun circuit_balance_transfer(): u8 { CIRCUIT_BALANCE_TRANSFER }

public fun circuit_range_proof(): u8 { CIRCUIT_RANGE_PROOF }

public fun circuit_ownership_proof(): u8 { CIRCUIT_OWNERSHIP_PROOF }

public fun transfer_pending(): u8 { TRANSFER_PENDING }

public fun transfer_verified(): u8 { TRANSFER_VERIFIED }

public fun transfer_failed(): u8 { TRANSFER_FAILED }

// ============================================
// CIRCUIT CONFIGURATION FUNCTIONS
// ============================================

/// Creates a TransferCircuitConfig for a balance transfer circuit.
/// This circuit proves: "I know amounts a, b such that a + b = total and a >= 0"
/// Public inputs: [sender_scalar, receiver_scalar, total_commitment]
public fun balance_transfer_config(): TransferCircuitConfig {
    TransferCircuitConfig {
        name: b"balance_transfer",
        circuit_type: CIRCUIT_BALANCE_TRANSFER,
        num_inputs: 3,
        curve_type: zk_verifier::curve_bn254(),
        description: b"Proves valid balance transfer without revealing amounts",
    }
}

/// Creates a TransferCircuitConfig for a range proof circuit.
/// This circuit proves: "I know a value v such that min <= v <= max"
/// Public inputs: [min_scalar, max_scalar]
public fun range_proof_config(): TransferCircuitConfig {
    TransferCircuitConfig {
        name: b"range_proof",
        circuit_type: CIRCUIT_RANGE_PROOF,
        num_inputs: 2,
        curve_type: zk_verifier::curve_bn254(),
        description: b"Proves a value is within a range without revealing it",
    }
}

/// Creates a TransferCircuitConfig for an ownership proof circuit.
/// This circuit proves: "I know the private key for this address"
/// Public inputs: [address_scalar]
public fun ownership_proof_config(): TransferCircuitConfig {
    TransferCircuitConfig {
        name: b"ownership_proof",
        circuit_type: CIRCUIT_OWNERSHIP_PROOF,
        num_inputs: 1,
        curve_type: zk_verifier::curve_bls12381(),
        description: b"Proves ownership of an address without revealing private key",
    }
}

/// Returns the config for a given circuit type
public fun get_circuit_config(circuit_type: u8): TransferCircuitConfig {
    if (circuit_type == CIRCUIT_BALANCE_TRANSFER) {
        balance_transfer_config()
    } else if (circuit_type == CIRCUIT_RANGE_PROOF) {
        range_proof_config()
    } else if (circuit_type == CIRCUIT_OWNERSHIP_PROOF) {
        ownership_proof_config()
    } else {
        abort EInvalidParameter
    }
}

// ============================================
// REGISTRY SETUP FUNCTIONS
// ============================================

/// Sets up a circuit registry with the standard transfer circuits.
/// In production, this would use real verification keys from a trusted setup.
///
/// ## Parameters
/// - `owner`: Address that controls the registry
///
/// ## Returns
/// A CircuitRegistry with the owner set
public fun setup_registry(owner: address, ctx: &mut TxContext): zk_verifier::CircuitRegistry {
    zk_verifier::create_registry(owner, ctx)
}

/// Returns the circuit ID for a given circuit name.
/// This is a deterministic hash of the name.
public fun get_circuit_id(name: &vector<u8>): vector<u8> {
    zk_verifier::create_circuit_id(name)
}

// ============================================
// PUBLIC INPUT CONSTRUCTION FUNCTIONS
// ============================================

/// Builds public inputs for a balance transfer proof.
/// Constructs the 3 required scalars: sender, receiver, total commitment.
///
/// ## Parameters
/// - `sender`: Sender address
/// - `receiver`: Receiver address
/// - `total`: Total amount (committed, not revealed)
///
/// ## Returns
/// Concatenated 32-byte scalars (96 bytes total)
public fun build_transfer_inputs(sender: address, receiver: address, total: u64): vector<u8> {
    let sender_scalar = zk_verifier::address_to_scalar(sender);
    let receiver_scalar = zk_verifier::address_to_scalar(receiver);
    let total_scalar = zk_verifier::u64_to_scalar(total);

    zk_verifier::concat_scalars(vector[sender_scalar, receiver_scalar, total_scalar])
}

/// Builds public inputs for a range proof.
///
/// ## Parameters
/// - `min_value`: Minimum of the range
/// - `max_value`: Maximum of the range
///
/// ## Returns
/// Concatenated 32-byte scalars (64 bytes total)
public fun build_range_proof_inputs(min_value: u64, max_value: u64): vector<u8> {
    assert!(min_value <= max_value, EInvalidParameter);

    let min_scalar = zk_verifier::u64_to_scalar(min_value);
    let max_scalar = zk_verifier::u64_to_scalar(max_value);

    zk_verifier::concat_scalars(vector[min_scalar, max_scalar])
}

/// Builds public inputs for an ownership proof.
///
/// ## Parameters
/// - `addr`: The address to prove ownership of
///
/// ## Returns
/// 32-byte scalar
public fun build_ownership_proof_inputs(addr: address): vector<u8> {
    let addr_scalar = zk_verifier::address_to_scalar(addr);
    zk_verifier::concat_scalars(vector[addr_scalar])
}

/// Creates a commitment hash for a private amount.
/// Used to create the "total commitment" public input.
public fun commit_amount(amount: u64, blinding_factor: &vector<u8>): vector<u8> {
    let mut data = zk_verifier::u64_to_scalar(amount);
    let mut i = 0;
    while (i < blinding_factor.length()) {
        data.push_back(blinding_factor[i]);
        i = i + 1;
    };
    hash::blake2b256(&data)
}

// ============================================
// TRANSFER FUNCTIONS
// ============================================

/// Submits a private transfer for verification.
///
/// ## Parameters
/// - `sender`: Sender address
/// - `receiver`: Receiver address
/// - `circuit_id`: ID of the circuit to verify against
/// - `public_inputs`: The public inputs for the proof
/// - `proof_bytes`: The ZK proof bytes
/// - `clock`: Clock for timestamps
/// - `ctx`: Transaction context
public fun submit_transfer(
    receiver: address,
    circuit_id: vector<u8>,
    public_inputs: vector<u8>,
    proof_bytes: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): PrivateTransfer {
    let sender = ctx.sender();
    assert!(sender != receiver, EInvalidParties);
    assert!(proof_bytes.length() > 0, EEmptyInput);

    let now = clock.timestamp_ms();
    let transfer = PrivateTransfer {
        id: object::new(ctx),
        sender,
        receiver,
        circuit_id,
        public_inputs,
        proof_bytes,
        status: TRANSFER_PENDING,
        created_at: now,
        verified_at: 0,
    };

    event::emit(TransferSubmitted {
        transfer_id: object::id(&transfer),
        sender,
        receiver,
        circuit_id: transfer.circuit_id,
    });

    transfer
}

/// Verifies a pending transfer against a circuit registry.
/// Updates the transfer status based on the verification result.
///
/// This calls the REAL `zk_verifier::verify_circuit_proof` (Groth16). Only the
/// proving-key / trusted-setup provisioning is out of scope for this example —
/// the on-chain verification itself is not mocked.
public fun verify_transfer(
    transfer: &mut PrivateTransfer,
    registry: &zk_verifier::CircuitRegistry,
    clock: &Clock,
): bool {
    assert!(transfer.status == TRANSFER_PENDING, EInvalidState);

    // Verify the circuit is registered and active
    let is_active = zk_verifier::is_circuit_active(registry, &transfer.circuit_id);

    if (!is_active) {
        transfer.status = TRANSFER_FAILED;
        let now = clock.timestamp_ms();
        transfer.verified_at = now;

        event::emit(TransferVerified {
            transfer_id: object::id(transfer),
            success: false,
            timestamp: now,
        });

        return false
    };

    // Verify the proof using the real ZK verifier
    let proof_valid = zk_verifier::verify_circuit_proof(
        registry,
        &transfer.circuit_id,
        &transfer.public_inputs,
        &transfer.proof_bytes,
    );

    let now = clock.timestamp_ms();
    transfer.verified_at = now;

    if (proof_valid) {
        transfer.status = TRANSFER_VERIFIED;
    } else {
        transfer.status = TRANSFER_FAILED;
    };

    event::emit(TransferVerified {
        transfer_id: object::id(transfer),
        success: proof_valid,
        timestamp: now,
    });

    proof_valid
}

/// Creates a verification log entry for auditing.
public fun log_verification(
    transfer: &PrivateTransfer,
    clock: &Clock,
    ctx: &mut TxContext,
): VerificationLog {
    let now = clock.timestamp_ms();
    let inputs_hash = hash::blake2b256(&transfer.public_inputs);

    VerificationLog {
        id: object::new(ctx),
        transfer_id: object::id(transfer),
        circuit_id: transfer.circuit_id,
        success: transfer.status == TRANSFER_VERIFIED,
        inputs_hash,
        timestamp: now,
    }
}

/// Creates a verification result struct for the transfer.
public fun create_transfer_verification_result(
    transfer: &PrivateTransfer,
): zk_verifier::VerificationResult {
    zk_verifier::create_verification_result(
        transfer.status == TRANSFER_VERIFIED,
        transfer.circuit_id,
        &transfer.public_inputs,
        transfer.verified_at,
    )
}

// ============================================
// ACCESSOR FUNCTIONS
// ============================================

// TransferCircuitConfig accessors
public fun config_name(config: &TransferCircuitConfig): &vector<u8> {
    &config.name
}

public fun config_circuit_type(config: &TransferCircuitConfig): u8 {
    config.circuit_type
}

public fun config_num_inputs(config: &TransferCircuitConfig): u64 {
    config.num_inputs
}

public fun config_curve_type(config: &TransferCircuitConfig): u8 {
    config.curve_type
}

public fun config_description(config: &TransferCircuitConfig): &vector<u8> {
    &config.description
}

// PrivateTransfer accessors
public fun transfer_sender(transfer: &PrivateTransfer): address {
    transfer.sender
}

public fun transfer_receiver(transfer: &PrivateTransfer): address {
    transfer.receiver
}

public fun transfer_circuit_id(transfer: &PrivateTransfer): &vector<u8> {
    &transfer.circuit_id
}

public fun transfer_public_inputs(transfer: &PrivateTransfer): &vector<u8> {
    &transfer.public_inputs
}

public fun transfer_proof_bytes(transfer: &PrivateTransfer): &vector<u8> {
    &transfer.proof_bytes
}

public fun transfer_status(transfer: &PrivateTransfer): u8 {
    transfer.status
}

public fun transfer_created_at(transfer: &PrivateTransfer): u64 {
    transfer.created_at
}

public fun transfer_verified_at(transfer: &PrivateTransfer): u64 {
    transfer.verified_at
}

// VerificationLog accessors
public fun log_transfer_id(log: &VerificationLog): ID {
    log.transfer_id
}

public fun log_circuit_id(log: &VerificationLog): &vector<u8> {
    &log.circuit_id
}

public fun log_success(log: &VerificationLog): bool {
    log.success
}

public fun log_inputs_hash(log: &VerificationLog): &vector<u8> {
    &log.inputs_hash
}

public fun log_timestamp(log: &VerificationLog): u64 {
    log.timestamp
}

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_transfer_for_testing(transfer: PrivateTransfer) {
    let PrivateTransfer { id, .. } = transfer;
    id.delete();
}

#[test_only]
public fun destroy_log_for_testing(log: VerificationLog) {
    let VerificationLog { id, .. } = log;
    id.delete();
}
