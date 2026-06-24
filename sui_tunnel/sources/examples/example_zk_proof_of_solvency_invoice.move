/// Example: ZK Proof of Solvency Invoice
///
/// A payer escrows funds in a real `Tunnel<T>` and proves IN ZERO-KNOWLEDGE that the
/// escrowed funds cover the invoice amount (a solvency / range proof) before the payment
/// settles to the payee.
///
/// ## Flow:
/// 1. The payer escrows `Coin<T>` in a fresh tunnel (payer = party A, payee = party B),
///    asserting on-chain that the deposit covers the invoice amount.
/// 2. Both parties register an active solvency circuit in a `CircuitRegistry`.
/// 3. The payer produces a Groth16 solvency proof over `build_solvency_inputs` (available
///    funds >= invoice amount, without revealing the full balance).
/// 4. `pay_invoice_with_proof` verifies the proof and dual-signed split, then settles the
///    invoice amount to the payee and the remainder to the payer.
/// 5. Before settlement the payer may `cancel_invoice` for a full refund.
///
/// ## Key Features:
/// - Real fund custody and settlement delegated to a two-party `Tunnel<T>`.
/// - Groth16-gated cooperative close over a registered solvency circuit.
/// - On-chain solvency floor: the deposit must cover the invoice amount at creation.
/// - Pre-activation refund exit for the payer.
///
/// ## Limitations:
/// Actual Groth16 verification requires a real trusted-setup verifying key registered via
/// `zk_verifier::register_circuit`; this example ships none, so the proof gate is only as
/// strong as the registered circuit. Settlement is also on a public chain: the final
/// balance split and party addresses are public. ZK can hide the proof witness, not the
/// on-chain settled amounts or recipient.
module sui_tunnel::example_zk_proof_of_solvency_invoice;

use sui::clock::Clock;
use sui::coin::Coin;
use sui::event;
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
const EInvalidPublicKey: vector<u8> = b"The public key is invalid or has the wrong length for its scheme.";

#[error]
const EInvalidZkProof: vector<u8> = b"The zero-knowledge proof is invalid.";

#[error]
const ECircuitNotRegistered: vector<u8> = b"The circuit id is not registered.";

#[error]
const EInsufficientBalance: vector<u8> = b"Insufficient balance for this operation.";

// ============================================
// CONSTANTS
// ============================================

/// Invoice status: Pending proof and settlement
const INVOICE_PENDING: u8 = 0;

/// Invoice status: Paid (proof verified, funds settled)
const INVOICE_PAID: u8 = 1;

/// Invoice status: Cancelled (refunded before settlement)
const INVOICE_CANCELLED: u8 = 2;

// ============================================
// STRUCTS
// ============================================

/// Descriptor for the solvency circuit: what inputs it expects and how to read them.
public struct SolvencyCircuitConfig has copy, drop, store {
    /// Human-readable circuit name
    name: vector<u8>,
    /// Number of public inputs required
    num_inputs: u64,
    /// Curve type (BLS12-381 or BN254)
    curve_type: u8,
    /// Description of what this circuit proves
    description: vector<u8>,
}

/// A proof-gated invoice payment backed by a real funded tunnel. The tunnel custodies the
/// payer's escrowed `Balance<T>`; a verified solvency proof plus a dual-signed settlement
/// releases the invoice amount to the payee.
public struct InvoicePayment<phantom T> has key, store {
    id: UID,
    /// The two-party tunnel custodying the escrowed funds.
    tunnel: Tunnel<T>,
    /// Circuit the solvency proof must satisfy.
    circuit_id: vector<u8>,
    /// Payer (party A / depositor).
    payer: address,
    /// Payee (party B / beneficiary).
    payee: address,
    /// The invoice amount owed to the payee.
    invoice_amount: u64,
    /// Off-chain invoice identifier.
    invoice_id: vector<u8>,
    /// Invoice status (`INVOICE_*`).
    status: u8,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when an invoice payment is created and escrowed.
public struct InvoiceCreated has copy, drop {
    payment_id: ID,
    payer: address,
    payee: address,
    invoice_amount: u64,
    circuit_id: vector<u8>,
}

/// Emitted when an invoice is paid after a verified solvency proof.
public struct InvoicePaid has copy, drop {
    payment_id: ID,
    invoice_amount: u64,
    timestamp: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS FOR CONSTANTS
// ============================================

/// Status value for an invoice awaiting its proof and settlement.
public fun invoice_pending(): u8 { INVOICE_PENDING }

/// Status value for an invoice whose proof verified and funds settled.
public fun invoice_paid(): u8 { INVOICE_PAID }

/// Status value for an invoice refunded before settlement.
public fun invoice_cancelled(): u8 { INVOICE_CANCELLED }

// ============================================
// CIRCUIT CONFIGURATION FUNCTIONS
// ============================================

/// Creates a `SolvencyCircuitConfig` for the solvency circuit.
/// This circuit proves: "I know available funds `f` such that `f >= invoice_amount`"
/// without revealing `f`. Public inputs: [payer_scalar, invoice_amount_scalar].
public fun solvency_config(): SolvencyCircuitConfig {
    SolvencyCircuitConfig {
        name: b"solvency",
        num_inputs: 2,
        curve_type: zk_verifier::curve_bn254(),
        description: b"Proves escrowed funds cover the invoice without revealing the balance",
    }
}

// ============================================
// REGISTRY SETUP FUNCTIONS
// ============================================

/// Sets up a circuit registry for the solvency circuit.
/// In production, this would use a real verification key from a trusted setup.
public fun setup_registry(owner: address, ctx: &mut TxContext): zk_verifier::CircuitRegistry {
    zk_verifier::create_registry(owner, ctx)
}

/// Returns the deterministic circuit ID for a given circuit name.
public fun circuit_id_for(name: &vector<u8>): vector<u8> {
    zk_verifier::create_circuit_id(name)
}

// ============================================
// PUBLIC INPUT CONSTRUCTION FUNCTIONS
// ============================================

/// Builds public inputs for a solvency proof: prove available funds cover the invoice
/// amount without revealing the full balance. The enforced coverage guarantee is the
/// on-chain solvency floor (`deposit >= invoice_amount` at creation); the proof over
/// these public inputs is an additional, circuit-dependent release gate and does not by
/// itself bind to the tunnel's escrowed balance.
///
/// ## Parameters
/// - `payer`: Payer address
/// - `invoice_amount`: Amount the proof must show is covered
///
/// ## Returns
/// Concatenated 32-byte scalars (64 bytes total)
public fun build_solvency_inputs(payer: address, invoice_amount: u64): vector<u8> {
    let payer_scalar = zk_verifier::address_to_scalar(payer);
    let amount_scalar = zk_verifier::u64_to_scalar(invoice_amount);

    zk_verifier::concat_scalars(vector[payer_scalar, amount_scalar])
}

// ============================================
// INVOICE LIFECYCLE
// ============================================

/// Escrows `deposit` in a fresh tunnel for a proof-gated invoice payment. The caller is
/// the payer (party A); `payee` is party B. The tunnel stays pre-activation (only the
/// payer funds it), so the payer can reclaim via `cancel_invoice` until settlement.
/// Aborts `EInvalidParties` if payer and payee match, `EEmptyInput` if the circuit id is
/// empty, `EInvalidPublicKey` if either key is empty, `EInvalidParameter` if the invoice
/// amount is zero, and `EInsufficientBalance` if the deposit does not cover the invoice.
public fun create_invoice_payment<T>(
    payee: address,
    payer_pk: vector<u8>,
    payee_pk: vector<u8>,
    circuit_id: vector<u8>,
    invoice_amount: u64,
    invoice_id: vector<u8>,
    deposit: Coin<T>,
    timeout_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): InvoicePayment<T> {
    let payer = ctx.sender();
    assert!(payer != payee, EInvalidParties);
    assert!(circuit_id.length() > 0, EEmptyInput);
    assert!(payer_pk.length() > 0 && payee_pk.length() > 0, EInvalidPublicKey);
    assert!(invoice_amount > 0, EInvalidParameter);
    assert!(deposit.value() >= invoice_amount, EInsufficientBalance);

    let mut tun = tunnel::create<T>(
        payer,
        payer_pk,
        signature::ed25519(),
        payee,
        payee_pk,
        signature::ed25519(),
        timeout_ms,
        0,
        clock,
        ctx,
    );
    tun.deposit_party_a(deposit, clock, ctx);

    let payment = InvoicePayment {
        id: object::new(ctx),
        tunnel: tun,
        circuit_id,
        payer,
        payee,
        invoice_amount,
        invoice_id,
        status: INVOICE_PENDING,
    };

    event::emit(InvoiceCreated {
        payment_id: object::id(&payment),
        payer,
        payee,
        invoice_amount,
        circuit_id: payment.circuit_id,
    });

    payment
}

// ============================================
// SETTLEMENT (PROOF-GATED)
// ============================================

/// Settles the invoice after verifying the Groth16 solvency proof against the registered
/// circuit. `payee_balance` must equal the invoice amount and the dual-signed split must
/// sum to the tunnel balance, so the payee receives exactly the invoice amount and the
/// payer the remainder. The proof is an additional release condition over the signed
/// settlement; its public inputs are derived from this invoice (payer + invoice amount),
/// not supplied by the caller, so a valid proof for an unrelated statement cannot settle
/// it. Aborts `EInvalidState` if not pending, `ECircuitNotRegistered` if the circuit is
/// inactive, `EInvalidZkProof` if the proof fails, `EInvalidParameter` if `payee_balance`
/// is not the invoice amount, or in the tunnel on a bad signature / split.
public fun pay_invoice_with_proof<T>(
    payment: &mut InvoicePayment<T>,
    registry: &zk_verifier::CircuitRegistry,
    proof_bytes: vector<u8>,
    payer_balance: u64,
    payee_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(payment.status == INVOICE_PENDING, EInvalidState);
    assert!(zk_verifier::is_circuit_active(registry, &payment.circuit_id), ECircuitNotRegistered);
    let public_inputs = build_solvency_inputs(payment.payer, payment.invoice_amount);
    assert!(
        zk_verifier::verify_circuit_proof(
            registry,
            &payment.circuit_id,
            &public_inputs,
            &proof_bytes,
        ),
        EInvalidZkProof,
    );
    assert!(payee_balance == payment.invoice_amount, EInvalidParameter);

    payment
        .tunnel
        .close_cooperative_and_transfer(
            payer_balance,
            payee_balance,
            sig_a,
            sig_b,
            timestamp,
            clock,
            ctx,
        );
    payment.status = INVOICE_PAID;

    event::emit(InvoicePaid {
        payment_id: object::id(payment),
        invoice_amount: payment.invoice_amount,
        timestamp: clock.timestamp_ms(),
    });
}

// ============================================
// CANCELLATION
// ============================================

/// Refunds the full escrowed deposit to the payer before settlement. Returns the coin so
/// the payer can route it in a PTB. Reuses the tunnel's pre-activation withdrawal, so only
/// the payer (the sole depositor) can reclaim. Aborts `EInvalidState` if not pending.
public fun cancel_invoice<T>(
    payment: &mut InvoicePayment<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(payment.status == INVOICE_PENDING, EInvalidState);
    payment.status = INVOICE_CANCELLED;
    payment.tunnel.withdraw_before_active(clock, ctx)
}

// ============================================
// ACCESSOR FUNCTIONS
// ============================================

// SolvencyCircuitConfig accessors

/// The human-readable circuit name.
public fun config_name(config: &SolvencyCircuitConfig): &vector<u8> {
    &config.name
}

/// The number of public inputs the circuit expects.
public fun config_num_inputs(config: &SolvencyCircuitConfig): u64 {
    config.num_inputs
}

/// The elliptic curve the circuit is defined over (BLS12-381 or BN254).
public fun config_curve_type(config: &SolvencyCircuitConfig): u8 {
    config.curve_type
}

/// The description of what the circuit proves.
public fun config_description(config: &SolvencyCircuitConfig): &vector<u8> {
    &config.description
}

// InvoicePayment accessors

/// Read-only access to the invoice's underlying tunnel.
public fun invoice_tunnel<T>(payment: &InvoicePayment<T>): &Tunnel<T> { &payment.tunnel }

/// The invoice status (`INVOICE_*`).
public fun invoice_status<T>(payment: &InvoicePayment<T>): u8 { payment.status }

/// The escrowed balance currently held by the tunnel.
public fun invoice_total_balance<T>(payment: &InvoicePayment<T>): u64 {
    payment.tunnel.total_balance()
}

/// The payer (depositor) address.
public fun invoice_payer<T>(payment: &InvoicePayment<T>): address { payment.payer }

/// The payee (beneficiary) address.
public fun invoice_payee<T>(payment: &InvoicePayment<T>): address { payment.payee }

/// The amount owed to the payee.
public fun invoice_amount<T>(payment: &InvoicePayment<T>): u64 { payment.invoice_amount }

/// The off-chain invoice identifier.
public fun invoice_id<T>(payment: &InvoicePayment<T>): &vector<u8> { &payment.invoice_id }

/// The circuit the solvency proof must satisfy.
public fun invoice_circuit_id<T>(payment: &InvoicePayment<T>): &vector<u8> {
    &payment.circuit_id
}

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_invoice_payment_for_testing<T>(payment: InvoicePayment<T>) {
    let InvoicePayment { id, tunnel, .. } = payment;
    id.delete();
    tunnel.destroy_for_testing();
}

#[test_only]
public fun set_status_for_testing<T>(payment: &mut InvoicePayment<T>, status: u8) {
    payment.status = status;
}

/// Exercises the real circuit-active gate and the real on-chain payee payout while
/// bypassing the Groth16 proof and settlement signatures, which need a trusted-setup
/// circuit and SDK-produced signatures unavailable in unit tests. The proof and signature
/// checks are covered independently by the zk_verifier and signature suites.
#[test_only]
public fun pay_invoice_no_proof_for_testing<T>(
    payment: &mut InvoicePayment<T>,
    registry: &zk_verifier::CircuitRegistry,
    payer_balance: u64,
    payee_balance: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(payment.status == INVOICE_PENDING, EInvalidState);
    assert!(zk_verifier::is_circuit_active(registry, &payment.circuit_id), ECircuitNotRegistered);
    assert!(payee_balance == payment.invoice_amount, EInvalidParameter);
    payment.tunnel.close_cooperative_no_sig_for_testing(payer_balance, payee_balance, clock, ctx);
    payment.status = INVOICE_PAID;
}
