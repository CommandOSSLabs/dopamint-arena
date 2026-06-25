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
/// ## Two paths:
/// - `PrivateTransfer` (record-only): the verification data pipeline — registry
///   management, public-input construction, and result tracking. Moves no funds.
/// - `ZkTransfer<T>` (real funds): escrows `Coin<T>` in a `Tunnel<T>` and releases it
///   to the receiver via a Groth16-gated, dual-signed cooperative close, with a
///   pre-activation refund for the payer.
///
/// ## Limitations:
/// Actual Groth16 verification requires a real trusted-setup verifying key registered
/// via `zk_verifier::register_circuit`; this example ships none, so the proof gate is
/// only as strong as the registered circuit. Settlement is also on a public chain: the
/// final balance split and party addresses are public. ZK can hide the proof witness,
/// not the on-chain settled amounts or recipient. Real amount privacy would need a
/// shielded-pool design the two-party tunnel does not provide.
module sui_tunnel::example_zk_private_transfer;

use sui::clock::Clock;
use sui::coin::Coin;
use sui::event;
use sui::hash;
use sui_tunnel::signature;
use sui_tunnel::tunnel::{Self, Tunnel};
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

#[error]
const EInvalidZkProof: vector<u8> = b"The zero-knowledge proof is invalid.";

#[error]
const ECircuitNotRegistered: vector<u8> = b"The circuit id is not registered.";

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
// PROOF-GATED TRANSFER (REAL FUND MOVEMENT)
// ============================================
//
// `PrivateTransfer` above is a record-only verification pipeline: it runs the real
// `zk_verifier` but moves no funds. `ZkTransfer<T>` below is the production-capable
// path. It escrows real `Coin<T>` in a two-party `Tunnel<T>` (payer = party A,
// receiver = party B) and releases it to the receiver only through
// `settle_with_proof`, which verifies a Groth16 proof against a registered circuit
// and then performs the tunnel's dual-signed cooperative close. All fund-movement
// security (balance-sum invariant, settlement-signature domain separation, the
// pre-activation refund exit) is enforced inside the tunnel.
//
// Limitations (see the module header): a production deployment must register a real
// trusted-setup verifying key via `zk_verifier::register_circuit`; this example
// cannot ship one, so the proof gate is only as strong as the registered circuit.
// More fundamentally, settlement is on a public chain: the `payer_balance` /
// `receiver_balance` split and the party addresses are public. ZK here can hide the
// proof witness, not the on-chain settlement amounts or recipient.

/// A proof-gated transfer backed by a real funded tunnel. The tunnel custodies the
/// payer's escrowed `Balance<T>`; a verified proof plus a dual-signed settlement
/// releases it to the receiver.
public struct ZkTransfer<phantom T> has key, store {
    id: UID,
    /// The two-party tunnel custodying the escrowed funds.
    tunnel: Tunnel<T>,
    /// Circuit the release proof must satisfy.
    circuit_id: vector<u8>,
    /// Payer (party A / depositor).
    payer: address,
    /// Receiver (party B / beneficiary).
    receiver: address,
    /// Transfer status (`TRANSFER_*`).
    status: u8,
}

/// Escrows `deposit` in a fresh tunnel for a proof-gated transfer. The caller is the
/// payer (party A); `receiver` is party B. The tunnel stays pre-activation (only the
/// payer funds it), so the payer can reclaim via `cancel_transfer` until release.
/// Aborts if payer and receiver are the same address or the deposit is empty.
public fun create_zk_transfer<T>(
    receiver: address,
    payer_pk: vector<u8>,
    receiver_pk: vector<u8>,
    circuit_id: vector<u8>,
    deposit: Coin<T>,
    timeout_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ZkTransfer<T> {
    let payer = ctx.sender();
    assert!(payer != receiver, EInvalidParties);
    assert!(deposit.value() > 0, EEmptyInput);

    let mut tun = tunnel::create<T>(
        payer,
        payer_pk,
        signature::ed25519(),
        receiver,
        receiver_pk,
        signature::ed25519(),
        timeout_ms,
        0,
        clock,
        ctx,
    );
    tun.deposit_party_a(deposit, clock, ctx);

    let transfer = ZkTransfer {
        id: object::new(ctx),
        tunnel: tun,
        circuit_id,
        payer,
        receiver,
        status: TRANSFER_PENDING,
    };

    event::emit(TransferSubmitted {
        transfer_id: object::id(&transfer),
        sender: payer,
        receiver,
        circuit_id: transfer.circuit_id,
    });

    transfer
}

/// Releases the escrowed funds with the agreed `payer_balance` / `receiver_balance`
/// split after verifying the Groth16 proof against the registered circuit. The split
/// must be dual-signed (the proof is an additional release condition over the
/// signed settlement) and sum to the tunnel balance. Aborts `ECircuitNotRegistered`
/// if the circuit is inactive, `EInvalidZkProof` if the proof fails, or in the tunnel
/// on a bad signature / balance split.
public fun settle_with_proof<T>(
    transfer: &mut ZkTransfer<T>,
    registry: &zk_verifier::CircuitRegistry,
    public_inputs: vector<u8>,
    proof_bytes: vector<u8>,
    payer_balance: u64,
    receiver_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(transfer.status == TRANSFER_PENDING, EInvalidState);
    assert!(zk_verifier::is_circuit_active(registry, &transfer.circuit_id), ECircuitNotRegistered);
    assert!(
        zk_verifier::verify_circuit_proof(
            registry,
            &transfer.circuit_id,
            &public_inputs,
            &proof_bytes,
        ),
        EInvalidZkProof,
    );

    transfer
        .tunnel
        .close_cooperative_and_transfer(
            payer_balance,
            receiver_balance,
            sig_a,
            sig_b,
            timestamp,
            clock,
            ctx,
        );
    transfer.status = TRANSFER_VERIFIED;

    event::emit(TransferVerified {
        transfer_id: object::id(transfer),
        success: true,
        timestamp: clock.timestamp_ms(),
    });
}

/// Refunds the full escrowed deposit to the payer before release. Returns the coin so
/// the payer can route it in a PTB. Reuses the tunnel's pre-activation withdrawal, so
/// only the payer (the sole depositor) can reclaim. Aborts if already settled.
public fun cancel_transfer<T>(
    transfer: &mut ZkTransfer<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(transfer.status == TRANSFER_PENDING, EInvalidState);
    transfer.status = TRANSFER_FAILED;
    transfer.tunnel.withdraw_before_active(clock, ctx)
}

/// Read-only access to the escrow's underlying tunnel.
public fun zk_transfer_tunnel<T>(transfer: &ZkTransfer<T>): &Tunnel<T> { &transfer.tunnel }

/// The transfer's status (`TRANSFER_*`).
public fun zk_transfer_status<T>(transfer: &ZkTransfer<T>): u8 { transfer.status }

/// The escrowed balance currently held by the tunnel.
public fun zk_transfer_total_balance<T>(transfer: &ZkTransfer<T>): u64 {
    transfer.tunnel.total_balance()
}

/// The payer (depositor) address.
public fun zk_transfer_payer<T>(transfer: &ZkTransfer<T>): address { transfer.payer }

/// The receiver (beneficiary) address.
public fun zk_transfer_receiver<T>(transfer: &ZkTransfer<T>): address { transfer.receiver }

/// The circuit the release proof must satisfy.
public fun zk_transfer_circuit_id<T>(transfer: &ZkTransfer<T>): &vector<u8> {
    &transfer.circuit_id
}

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_zk_transfer_for_testing<T>(transfer: ZkTransfer<T>) {
    let ZkTransfer { id, tunnel, .. } = transfer;
    id.delete();
    tunnel.destroy_for_testing();
}

/// Exercises the real circuit-active gate and the real on-chain receiver payout while
/// bypassing the Groth16 proof and settlement signatures, which need a trusted-setup
/// circuit and SDK-produced signatures unavailable in unit tests. The proof and
/// signature checks are covered independently by the zk_verifier and signature suites.
#[test_only]
public fun settle_release_no_proof_for_testing<T>(
    transfer: &mut ZkTransfer<T>,
    registry: &zk_verifier::CircuitRegistry,
    payer_balance: u64,
    receiver_balance: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(transfer.status == TRANSFER_PENDING, EInvalidState);
    assert!(zk_verifier::is_circuit_active(registry, &transfer.circuit_id), ECircuitNotRegistered);
    transfer
        .tunnel
        .close_cooperative_no_sig_for_testing(payer_balance, receiver_balance, clock, ctx);
    transfer.status = TRANSFER_VERIFIED;
}

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
