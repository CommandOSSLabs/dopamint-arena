/// Example: Multi-Hop Payment
///
/// Lightning Network-style payment routing through multiple tunnels.
/// Demonstrates the hop module for trustless multi-party payments.
///
/// ## Flow:
/// 1. Sender creates a route through multiple intermediaries
/// 2. HTLCs are set up along the path (forward direction)
/// 3. Receiver reveals preimage to claim
/// 4. Preimage propagates backward, settling all HTLCs
///
/// ## Key Features:
/// - Atomic payments (all-or-nothing)
/// - No trust in intermediaries
/// - Cascading timeouts for safety
module sui_tunnel::example_multi_hop_payment;

use sui::clock::Clock;
use sui::event;
use sui::hash;
use sui_tunnel::hop;
use sui_tunnel::tunnel::Tunnel;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidHop: vector<u8> = b"The hop is invalid.";

#[error]
const EHopTunnelMismatch: vector<u8> = b"The hop's tunnel id does not match the provided tunnel.";

// ============================================
// CONSTANTS
// ============================================

/// Payment status: Created
const PAYMENT_CREATED: u8 = 0;

/// Payment status: In flight (HTLCs set up)
const PAYMENT_IN_FLIGHT: u8 = 1;

/// Payment status: Completed (all HTLCs settled)
const PAYMENT_COMPLETED: u8 = 2;

/// Payment status: Failed (timeout or error)
const PAYMENT_FAILED: u8 = 3;

/// Default timeout per hop: 2 minutes
const DEFAULT_HOP_TIMEOUT_MS: u64 = 120000;

/// Final hop timeout: 10 minutes
const FINAL_HOP_TIMEOUT_MS: u64 = 600000;

// ============================================
// STRUCTS
// ============================================

/// A multi-hop payment
public struct MultiHopPayment has key, store {
    id: UID,
    /// Unique payment identifier
    payment_id: vector<u8>,
    /// The payment route
    route: hop::Route,
    /// Payment hash (hash of preimage)
    payment_hash: vector<u8>,
    /// Preimage (set once payment completes)
    preimage: vector<u8>,
    /// Current status
    status: u8,
    /// Amount being sent
    amount: u64,
    /// Total fees
    total_fees: u64,
    /// HTLCs for each hop
    htlcs: vector<hop::HTLC>,
    /// Number of settled HTLCs
    settled_count: u64,
}

/// Invoice for receiving a payment
public struct PaymentInvoice has copy, drop, store {
    /// Payment hash
    payment_hash: vector<u8>,
    /// Amount to receive
    amount: u64,
    /// Receiver address
    receiver: address,
    /// Expiry timestamp
    expiry_ms: u64,
    /// Description/memo
    memo: vector<u8>,
}

/// Receipt for a completed payment
public struct PaymentReceipt has copy, drop, store {
    /// Payment ID
    payment_id: vector<u8>,
    /// Preimage (proof of payment)
    preimage: vector<u8>,
    /// Amount paid
    amount: u64,
    /// Fees paid
    fees: u64,
    /// Sender
    sender: address,
    /// Receiver
    receiver: address,
    /// Completion timestamp
    completed_at: u64,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a payment is initiated (HTLCs set up)
public struct PaymentInitiated has copy, drop {
    sender: address,
    receiver: address,
    amount: u64,
    hop_count: u64,
}

/// Emitted when a payment is completed
public struct PaymentCompleted has copy, drop {
    sender: address,
    receiver: address,
    amount: u64,
    fees: u64,
}

/// Emitted when a payment fails
public struct PaymentFailed has copy, drop {
    sender: address,
    receiver: address,
    amount: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS
// ============================================

public fun payment_created(): u8 { PAYMENT_CREATED }

public fun payment_in_flight(): u8 { PAYMENT_IN_FLIGHT }

public fun payment_completed(): u8 { PAYMENT_COMPLETED }

public fun payment_failed(): u8 { PAYMENT_FAILED }

public fun default_hop_timeout_ms(): u64 { DEFAULT_HOP_TIMEOUT_MS }

public fun final_hop_timeout_ms(): u64 { FINAL_HOP_TIMEOUT_MS }

// ============================================
// INVOICE FUNCTIONS
// ============================================

/// Creates a payment invoice
public fun create_invoice(
    preimage: &vector<u8>,
    amount: u64,
    receiver: address,
    expiry_ms: u64,
    memo: vector<u8>,
): PaymentInvoice {
    PaymentInvoice {
        payment_hash: hop::create_payment_hash(preimage),
        amount,
        receiver,
        expiry_ms,
        memo,
    }
}

/// Gets the payment hash from an invoice
public fun invoice_payment_hash(invoice: &PaymentInvoice): &vector<u8> {
    &invoice.payment_hash
}

/// Gets the amount from an invoice
public fun invoice_amount(invoice: &PaymentInvoice): u64 { invoice.amount }

/// Gets the receiver from an invoice
public fun invoice_receiver(invoice: &PaymentInvoice): address { invoice.receiver }

/// Gets the expiry from an invoice
public fun invoice_expiry_ms(invoice: &PaymentInvoice): u64 { invoice.expiry_ms }

/// Gets the memo from an invoice
public fun invoice_memo(invoice: &PaymentInvoice): &vector<u8> { &invoice.memo }

// ============================================
// PAYMENT FUNCTIONS
// ============================================

/// Creates a payment ID
fun create_payment_id(payment_hash: &vector<u8>, sender: address, timestamp: u64): vector<u8> {
    let mut data = vector[];
    data.append(*payment_hash);
    data.append(sender.to_bytes());

    // Timestamp as little-endian u64.
    data.push_back((timestamp & 0xFF) as u8);
    data.push_back(((timestamp >> 8) & 0xFF) as u8);
    data.push_back(((timestamp >> 16) & 0xFF) as u8);
    data.push_back(((timestamp >> 24) & 0xFF) as u8);
    data.push_back(((timestamp >> 32) & 0xFF) as u8);
    data.push_back(((timestamp >> 40) & 0xFF) as u8);
    data.push_back(((timestamp >> 48) & 0xFF) as u8);
    data.push_back(((timestamp >> 56) & 0xFF) as u8);

    hash::blake2b256(&data)
}

/// Creates a new multi-hop payment from an invoice
public fun create_payment(
    invoice: &PaymentInvoice,
    clock: &Clock,
    ctx: &mut TxContext,
): MultiHopPayment {
    let sender = ctx.sender();
    let timestamp = clock.timestamp_ms();
    let route = hop::create_route(
        sender,
        invoice.receiver,
        invoice.amount,
        timestamp,
    );

    MultiHopPayment {
        id: object::new(ctx),
        payment_id: create_payment_id(&invoice.payment_hash, sender, timestamp),
        route,
        payment_hash: invoice.payment_hash,
        preimage: vector[],
        status: PAYMENT_CREATED,
        amount: invoice.amount,
        total_fees: 0,
        htlcs: vector[],
        settled_count: 0,
    }
}

/// Adds a hop to the payment route. Only the route sender can add hops.
public fun add_payment_hop(
    payment: &mut MultiHopPayment,
    tunnel_id: vector<u8>,
    node: address,
    fee: u64,
    timeout_ms: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == hop::route_sender(&payment.route), ENotAuthorized);
    assert!(payment.status == PAYMENT_CREATED, EInvalidState);
    hop::add_hop(&mut payment.route, tunnel_id, node, fee, timeout_ms);
    payment.total_fees = payment.total_fees + fee;
}

/// Validates the payment route
public fun validate_payment(payment: &MultiHopPayment): bool {
    let validation = hop::validate_route(&payment.route);
    hop::validation_valid(&validation)
}

/// Sets up HTLCs along the route (makes payment "in flight").
/// Only the route sender can set up HTLCs.
public fun setup_htlcs(
    payment: &mut MultiHopPayment,
    base_timeout_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == hop::route_sender(&payment.route), ENotAuthorized);
    assert!(payment.status == PAYMENT_CREATED, EInvalidState);

    let route = &payment.route;
    let hop_count = hop::route_hop_count(route);
    assert!(hop_count > 0, EInvalidHop);

    // Cascading timeouts are relative durations; anchor them to the current
    // clock so HTLC expiry_ms is the absolute timestamp tunnel.lock_htlc expects.
    let now = clock.timestamp_ms();
    let timeouts = hop::create_cascading_timeouts(
        base_timeout_ms,
        hop_count,
        DEFAULT_HOP_TIMEOUT_MS,
    );

    // Create HTLCs for each hop
    let mut current_amount = payment.amount;
    let mut i = hop_count;

    // Work backwards (receiver to sender) for amounts
    // Each hop adds its fee
    while (i > 0) {
        i = i - 1;
        let hop_ref = hop::route_get_hop(route, i);
        let fee = hop::hop_fee(hop_ref);

        // Amount at this hop includes fees for subsequent hops
        let htlc_amount = if (i == hop_count - 1) {
            payment.amount
        } else {
            current_amount + fee
        };

        current_amount = htlc_amount;

        let sender_addr = if (i == 0) {
            hop::route_sender(route)
        } else {
            let prev_hop = hop::route_get_hop(route, i - 1);
            hop::hop_node_address(prev_hop)
        };

        let htlc = hop::create_htlc(
            payment.payment_hash,
            htlc_amount,
            sender_addr,
            hop::hop_node_address(hop_ref),
            now + timeouts[i],
        );

        payment.htlcs.push_back(htlc);
    };

    // Reverse HTLCs to be in forward order
    payment.htlcs.reverse();

    hop::activate_route(&mut payment.route);
    payment.status = PAYMENT_IN_FLIGHT;

    event::emit(PaymentInitiated {
        sender: hop::route_sender(&payment.route),
        receiver: hop::route_receiver(&payment.route),
        amount: payment.amount,
        hop_count,
    });
}

/// Receiver claims the payment with preimage.
/// Only the route receiver can claim the payment.
public fun claim_payment(
    payment: &mut MultiHopPayment,
    preimage: vector<u8>,
    ctx: &TxContext,
): bool {
    assert!(ctx.sender() == hop::route_receiver(&payment.route), ENotAuthorized);
    assert!(payment.status == PAYMENT_IN_FLIGHT, EInvalidState);

    // Verify preimage matches payment hash
    let computed_hash = hop::create_payment_hash(&preimage);
    if (computed_hash != payment.payment_hash) {
        return false
    };

    // Claim all HTLCs with the preimage
    let htlc_count = payment.htlcs.length();
    let mut i = htlc_count;

    // Claim backwards (receiver to sender)
    while (i > 0) {
        i = i - 1;
        let htlc = &mut payment.htlcs[i];
        let claimed = hop::claim_htlc_internal(htlc, preimage);
        assert!(claimed, EInvalidState);
    };

    payment.preimage = preimage;
    payment.settled_count = htlc_count;
    payment.status = PAYMENT_COMPLETED;
    hop::complete_route(&mut payment.route);

    event::emit(PaymentCompleted {
        sender: hop::route_sender(&payment.route),
        receiver: hop::route_receiver(&payment.route),
        amount: payment.amount,
        fees: payment.total_fees,
    });

    true
}

/// Fails the payment (timeout or error). Only the route sender can fail.
public fun fail_payment(payment: &mut MultiHopPayment, clock: &Clock, ctx: &TxContext) {
    assert!(ctx.sender() == hop::route_sender(&payment.route), ENotAuthorized);
    assert!(
        payment.status == PAYMENT_CREATED || payment.status == PAYMENT_IN_FLIGHT,
        EInvalidState,
    );

    let current_time_ms = clock.timestamp_ms();

    // Expire any pending, past-expiry HTLCs. The route sender drives the
    // unwind across every hop, but intermediate HTLCs have intermediary-node
    // senders, so `expire_htlc` (which is sender-gated) would abort on the
    // first non-sender hop. `expire_htlc_internal` skips that per-HTLC sender
    // check — authorization is already established by the route-sender gate
    // above — and simply no-ops on HTLCs that are not yet expired.
    payment.htlcs.do_mut!(|htlc| {
        if (hop::htlc_status(htlc) == hop::htlc_status_pending()) {
            hop::expire_htlc_internal(htlc, current_time_ms);
        };
    });

    payment.status = PAYMENT_FAILED;
    hop::fail_route(&mut payment.route);

    event::emit(PaymentFailed {
        sender: hop::route_sender(&payment.route),
        receiver: hop::route_receiver(&payment.route),
        amount: payment.amount,
    });
}

/// Creates a receipt for a completed payment
public fun create_receipt(payment: &MultiHopPayment, completed_at: u64): PaymentReceipt {
    assert!(payment.status == PAYMENT_COMPLETED, EInvalidState);

    PaymentReceipt {
        payment_id: payment.payment_id,
        preimage: payment.preimage,
        amount: payment.amount,
        fees: payment.total_fees,
        sender: hop::route_sender(&payment.route),
        receiver: hop::route_receiver(&payment.route),
        completed_at,
    }
}

// ============================================
// PAYMENT ACCESSORS
// ============================================

public fun payment_id(payment: &MultiHopPayment): &vector<u8> { &payment.payment_id }

public fun payment_hash(payment: &MultiHopPayment): &vector<u8> { &payment.payment_hash }

public fun payment_preimage(payment: &MultiHopPayment): &vector<u8> { &payment.preimage }

public fun payment_status(payment: &MultiHopPayment): u8 { payment.status }

public fun payment_amount(payment: &MultiHopPayment): u64 { payment.amount }

public fun payment_total_fees(payment: &MultiHopPayment): u64 { payment.total_fees }

public fun payment_route(payment: &MultiHopPayment): &hop::Route { &payment.route }

public fun payment_htlc_count(payment: &MultiHopPayment): u64 { payment.htlcs.length() }

public fun payment_settled_count(payment: &MultiHopPayment): u64 { payment.settled_count }

// ============================================
// RECEIPT ACCESSORS
// ============================================

public fun receipt_payment_id(receipt: &PaymentReceipt): &vector<u8> { &receipt.payment_id }

public fun receipt_preimage(receipt: &PaymentReceipt): &vector<u8> { &receipt.preimage }

public fun receipt_amount(receipt: &PaymentReceipt): u64 { receipt.amount }

public fun receipt_fees(receipt: &PaymentReceipt): u64 { receipt.fees }

public fun receipt_sender(receipt: &PaymentReceipt): address { receipt.sender }

public fun receipt_receiver(receipt: &PaymentReceipt): address { receipt.receiver }

public fun receipt_completed_at(receipt: &PaymentReceipt): u64 { receipt.completed_at }

// ============================================
// UTILITY FUNCTIONS
// ============================================

/// Calculates total amount needed for a payment (amount + fees)
public fun calculate_total_needed(payment: &MultiHopPayment): u64 {
    payment.amount + payment.total_fees
}

/// Checks if payment is successful
public fun is_payment_successful(payment: &MultiHopPayment): bool {
    payment.status == PAYMENT_COMPLETED
}

/// Checks if payment can be retried
public fun can_retry(payment: &MultiHopPayment): bool {
    payment.status == PAYMENT_FAILED
}

// ============================================
// ON-CHAIN HTLC ROUTING (REAL FUND MOVEMENT)
// ============================================
//
// Everything above operates on `hop::HTLC` value structs: pure off-chain routing
// math that moves no funds. The functions below execute the SAME plan against real
// funded `Tunnel<T>` channels using the tunnel's in-tunnel HTLCs. Each route edge is
// an independent, already-funded, active two-party tunnel; the orchestrator locks an
// HTLC per edge (forward), the receiver claims with the preimage, and that preimage
// propagates upstream so each node claims its incoming HTLC — moving real `Coin<T>`.
// On timeout, each locker reclaims via `expire_hop_htlc`. Cascading timeouts make the
// chain safe exactly as in Lightning; atomicity is economic, not transactional.
//
// All on-chain enforcement (32-byte payment hash, amount <= locker balance, the
// `party_a + party_b == balance` invariant, preimage/expiry checks, domain-separated
// HTLC signatures) lives in `tunnel`, not here. This module only binds each plan hop
// to its real tunnel and drives the tunnel primitives.

/// Emitted when a hop's HTLC is locked on-chain.
public struct HopHTLCLocked has copy, drop {
    payment_hash: vector<u8>,
    tunnel_id: ID,
    hop_index: u64,
    amount: u64,
    receiver: address,
}

/// Emitted when a hop's HTLC is claimed on-chain with the preimage.
public struct HopHTLCClaimed has copy, drop {
    payment_hash: vector<u8>,
    tunnel_id: ID,
    hop_index: u64,
}

/// Emitted when a hop's HTLC is reclaimed by its locker after expiry.
public struct HopHTLCExpired has copy, drop {
    payment_hash: vector<u8>,
    tunnel_id: ID,
    hop_index: u64,
}

/// The canonical route label for a funded tunnel. Pass this as a hop's `tunnel_id`
/// when building the route so the on-chain orchestration can bind the hop to the real
/// channel.
public fun tunnel_route_id<T>(tunnel: &Tunnel<T>): vector<u8> {
    object::id(tunnel).to_bytes()
}

/// Asserts the route hop at `hop_index` references `tunnel`.
fun assert_hop_bound<T>(payment: &MultiHopPayment, tunnel: &Tunnel<T>, hop_index: u64) {
    let route = &payment.route;
    assert!(hop_index < hop::route_hop_count(route), EInvalidHop);
    let hop_ref = hop::route_get_hop(route, hop_index);
    assert!(*hop::hop_tunnel_id(hop_ref) == tunnel_route_id(tunnel), EHopTunnelMismatch);
}

/// Locks the on-chain HTLC for hop `hop_index` in its funded tunnel, carving the hop
/// amount out of the locker's tunnel balance. The route hop must reference this tunnel
/// and the counterparty must have signed the HTLC terms. The same payment hash is
/// reused on every edge so one preimage settles the whole route.
public fun lock_hop_htlc<T>(
    payment: &MultiHopPayment,
    tunnel: &mut Tunnel<T>,
    hop_index: u64,
    counterparty_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(payment.status == PAYMENT_IN_FLIGHT, EInvalidState);
    assert_hop_bound(payment, tunnel, hop_index);

    let htlc = &payment.htlcs[hop_index];
    let amount = hop::htlc_amount(htlc);
    let receiver = hop::htlc_receiver(htlc);
    let expiry_ms = hop::htlc_expiry_ms(htlc);
    let tunnel_id = object::id(tunnel);

    tunnel.lock_htlc(
        payment.payment_hash,
        amount,
        receiver,
        expiry_ms,
        counterparty_sig,
        clock,
        ctx,
    );

    event::emit(HopHTLCLocked {
        payment_hash: payment.payment_hash,
        tunnel_id,
        hop_index,
        amount,
        receiver,
    });
}

/// Claims the on-chain HTLC for hop `hop_index` with the preimage, transferring the
/// hop amount to the receiver. Reveals the preimage so the upstream node can claim its
/// own incoming HTLC. Only the HTLC receiver can call it (enforced by the tunnel).
public fun claim_hop_htlc<T>(
    payment: &MultiHopPayment,
    tunnel: &mut Tunnel<T>,
    hop_index: u64,
    preimage: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_hop_bound(payment, tunnel, hop_index);
    let tunnel_id = object::id(tunnel);

    tunnel.claim_htlc_in_tunnel(payment.payment_hash, preimage, clock, ctx);

    event::emit(HopHTLCClaimed {
        payment_hash: payment.payment_hash,
        tunnel_id,
        hop_index,
    });
}

/// Reclaims the on-chain HTLC for hop `hop_index` after its expiry, returning the
/// locked amount to the locker. Only the HTLC sender can call it (enforced by the
/// tunnel). Cascading timeouts guarantee an upstream locker can always reclaim.
public fun expire_hop_htlc<T>(
    payment: &MultiHopPayment,
    tunnel: &mut Tunnel<T>,
    hop_index: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_hop_bound(payment, tunnel, hop_index);
    let tunnel_id = object::id(tunnel);

    tunnel.expire_htlc_in_tunnel(payment.payment_hash, clock, ctx);

    event::emit(HopHTLCExpired {
        payment_hash: payment.payment_hash,
        tunnel_id,
        hop_index,
    });
}

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_for_testing(payment: MultiHopPayment) {
    let MultiHopPayment { id, .. } = payment;
    id.delete();
}

/// Locks a hop's HTLC without a counterparty signature, exercising the real on-chain
/// HTLC fund movement. Signature verification is covered by the signature suite.
#[test_only]
public fun lock_hop_htlc_no_sig_for_testing<T>(
    payment: &MultiHopPayment,
    tunnel: &mut Tunnel<T>,
    hop_index: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(payment.status == PAYMENT_IN_FLIGHT, EInvalidState);
    assert_hop_bound(payment, tunnel, hop_index);
    let htlc = &payment.htlcs[hop_index];
    tunnel.lock_htlc_no_sig_for_testing(
        payment.payment_hash,
        hop::htlc_amount(htlc),
        hop::htlc_receiver(htlc),
        hop::htlc_expiry_ms(htlc),
        clock,
        ctx,
    );
}
