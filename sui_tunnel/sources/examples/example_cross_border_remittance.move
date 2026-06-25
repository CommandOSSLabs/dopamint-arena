/// Example: Cross Border Remittance
///
/// Cross-border remittance routed through a corridor of correspondent
/// intermediaries using Lightning-style atomic multi-hop HTLCs.
///
/// ## Flow:
/// 1. Sender creates a corridor route through multiple correspondents
/// 2. HTLCs are set up along the corridor (forward direction)
/// 3. Recipient reveals preimage to claim
/// 4. Preimage propagates backward, settling all HTLCs
///
/// ## Key Features:
/// - Atomic settlement (all-or-nothing)
/// - No trust in correspondent intermediaries
/// - Cascading timeouts for safety
/// - Off-chain FX/corridor metadata framing
module sui_tunnel::example_cross_border_remittance;

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

#[error]
const EOverflow: vector<u8> = b"The operation would cause an arithmetic overflow.";

// ============================================
// CONSTANTS
// ============================================

/// Remittance status: Created
const REMITTANCE_CREATED: u8 = 0;

/// Remittance status: In flight (HTLCs set up)
const REMITTANCE_IN_FLIGHT: u8 = 1;

/// Remittance status: Settled (all HTLCs settled)
const REMITTANCE_SETTLED: u8 = 2;

/// Remittance status: Failed (timeout or error)
const REMITTANCE_FAILED: u8 = 3;

/// Default timeout per corridor hop: 2 minutes
const DEFAULT_CORRIDOR_TIMEOUT_MS: u64 = 120000;

/// Final corridor hop timeout: 10 minutes
const FINAL_CORRIDOR_TIMEOUT_MS: u64 = 600000;

/// Fixed-point scale for FX rates (1_000_000 == 1.0)
const FX_RATE_SCALE: u64 = 1000000;

// ============================================
// STRUCTS
// ============================================

/// A cross-border remittance
public struct Remittance has key, store {
    id: UID,
    /// Unique remittance identifier
    remittance_id: vector<u8>,
    /// The corridor route
    route: hop::Route,
    /// Payment hash (hash of preimage)
    payment_hash: vector<u8>,
    /// Preimage (set once the remittance settles)
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

/// Invoice for receiving a remittance
public struct RemittanceInvoice has copy, drop, store {
    /// Payment hash
    payment_hash: vector<u8>,
    /// Amount to receive (in source currency units)
    amount: u64,
    /// Recipient address
    receiver: address,
    /// Expiry timestamp
    expiry_ms: u64,
    /// Description/memo
    memo: vector<u8>,
    /// Source currency ISO code (off-chain metadata)
    source_currency: vector<u8>,
    /// Destination currency ISO code (off-chain metadata)
    dest_currency: vector<u8>,
    /// Quoted FX rate scaled by FX_RATE_SCALE (off-chain metadata)
    fx_rate: u64,
}

/// Receipt for a settled remittance
public struct RemittanceReceipt has copy, drop, store {
    /// Remittance ID
    remittance_id: vector<u8>,
    /// Preimage (proof of settlement)
    preimage: vector<u8>,
    /// Amount sent in source currency
    source_amount: u64,
    /// Amount delivered in destination currency
    dest_amount: u64,
    /// Source currency ISO code
    source_currency: vector<u8>,
    /// Destination currency ISO code
    dest_currency: vector<u8>,
    /// Quoted FX rate scaled by FX_RATE_SCALE
    fx_rate: u64,
    /// Fees paid
    fees: u64,
    /// Sender
    sender: address,
    /// Recipient
    receiver: address,
    /// Settlement timestamp
    completed_at: u64,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a remittance is initiated (HTLCs set up)
public struct RemittanceInitiated has copy, drop {
    sender: address,
    receiver: address,
    amount: u64,
    hop_count: u64,
}

/// Emitted when a remittance is settled
public struct RemittanceSettled has copy, drop {
    sender: address,
    receiver: address,
    amount: u64,
    fees: u64,
}

/// Emitted when a remittance fails
public struct RemittanceFailed has copy, drop {
    sender: address,
    receiver: address,
    amount: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS
// ============================================

/// Status code for a freshly initiated remittance with no HTLCs set up yet.
public fun remittance_created(): u8 { REMITTANCE_CREATED }

/// Status code for a remittance whose corridor HTLCs are locked.
public fun remittance_in_flight(): u8 { REMITTANCE_IN_FLIGHT }

/// Status code for a fully settled remittance.
public fun remittance_settled(): u8 { REMITTANCE_SETTLED }

/// Status code for a remittance that timed out or was unwound.
public fun remittance_failed(): u8 { REMITTANCE_FAILED }

/// Default per-hop corridor timeout in milliseconds.
public fun default_corridor_timeout_ms(): u64 { DEFAULT_CORRIDOR_TIMEOUT_MS }

/// Timeout in milliseconds for the final corridor hop.
public fun final_corridor_timeout_ms(): u64 { FINAL_CORRIDOR_TIMEOUT_MS }

/// Fixed-point scale for FX rates (1_000_000 == 1.0).
public fun fx_rate_scale(): u64 { FX_RATE_SCALE }

// ============================================
// FX HELPERS
// ============================================

/// Quotes the destination amount for a source amount at the given FX rate
/// (scaled by FX_RATE_SCALE): `source_amount * fx_rate / FX_RATE_SCALE`. The
/// multiplication is guarded up front, aborting EOverflow when
/// `source_amount * fx_rate` would exceed u64.
public fun quote_dest_amount(source_amount: u64, fx_rate: u64): u64 {
    assert!(source_amount == 0 || fx_rate <= std::u64::max_value!() / source_amount, EOverflow);
    source_amount * fx_rate / FX_RATE_SCALE
}

// ============================================
// INVOICE FUNCTIONS
// ============================================

/// Creates a remittance invoice
public fun create_remittance_invoice(
    preimage: &vector<u8>,
    amount: u64,
    receiver: address,
    expiry_ms: u64,
    memo: vector<u8>,
    source_currency: vector<u8>,
    dest_currency: vector<u8>,
    fx_rate: u64,
): RemittanceInvoice {
    RemittanceInvoice {
        payment_hash: hop::create_payment_hash(preimage),
        amount,
        receiver,
        expiry_ms,
        memo,
        source_currency,
        dest_currency,
        fx_rate,
    }
}

/// Gets the payment hash from an invoice
public fun invoice_payment_hash(invoice: &RemittanceInvoice): &vector<u8> {
    &invoice.payment_hash
}

/// Gets the amount from an invoice
public fun invoice_amount(invoice: &RemittanceInvoice): u64 { invoice.amount }

/// Gets the receiver from an invoice
public fun invoice_receiver(invoice: &RemittanceInvoice): address { invoice.receiver }

/// Gets the expiry from an invoice
public fun invoice_expiry_ms(invoice: &RemittanceInvoice): u64 { invoice.expiry_ms }

/// Gets the memo from an invoice
public fun invoice_memo(invoice: &RemittanceInvoice): &vector<u8> { &invoice.memo }

/// Gets the source currency code from an invoice
public fun invoice_source_currency(invoice: &RemittanceInvoice): &vector<u8> {
    &invoice.source_currency
}

/// Gets the destination currency code from an invoice
public fun invoice_dest_currency(invoice: &RemittanceInvoice): &vector<u8> {
    &invoice.dest_currency
}

/// Gets the quoted FX rate from an invoice
public fun invoice_fx_rate(invoice: &RemittanceInvoice): u64 { invoice.fx_rate }

// ============================================
// REMITTANCE FUNCTIONS
// ============================================

/// Creates a remittance ID
fun create_remittance_id(payment_hash: &vector<u8>, sender: address, timestamp: u64): vector<u8> {
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

/// Creates a new remittance from an invoice
public fun initiate_remittance(
    invoice: &RemittanceInvoice,
    clock: &Clock,
    ctx: &mut TxContext,
): Remittance {
    let sender = ctx.sender();
    let timestamp = clock.timestamp_ms();
    let route = hop::create_route(
        sender,
        invoice.receiver,
        invoice.amount,
        timestamp,
    );

    Remittance {
        id: object::new(ctx),
        remittance_id: create_remittance_id(&invoice.payment_hash, sender, timestamp),
        route,
        payment_hash: invoice.payment_hash,
        preimage: vector[],
        status: REMITTANCE_CREATED,
        amount: invoice.amount,
        total_fees: 0,
        htlcs: vector[],
        settled_count: 0,
    }
}

/// Adds a hop to the corridor route. Only the route sender can add hops.
public fun add_corridor_hop(
    remittance: &mut Remittance,
    tunnel_id: vector<u8>,
    node: address,
    fee: u64,
    timeout_ms: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == hop::route_sender(&remittance.route), ENotAuthorized);
    assert!(remittance.status == REMITTANCE_CREATED, EInvalidState);
    hop::add_hop(&mut remittance.route, tunnel_id, node, fee, timeout_ms);
    remittance.total_fees = remittance.total_fees + fee;
}

/// Validates the corridor route
public fun validate_remittance(remittance: &Remittance): bool {
    let validation = hop::validate_route(&remittance.route);
    hop::validation_valid(&validation)
}

/// Sets up HTLCs along the corridor (makes remittance "in flight").
/// Only the route sender can set up HTLCs.
public fun setup_corridor_htlcs(
    remittance: &mut Remittance,
    base_timeout_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == hop::route_sender(&remittance.route), ENotAuthorized);
    assert!(remittance.status == REMITTANCE_CREATED, EInvalidState);

    let route = &remittance.route;
    let hop_count = hop::route_hop_count(route);
    assert!(hop_count > 0, EInvalidHop);

    // Cascading timeouts are relative durations; anchor them to the current
    // clock so HTLC expiry_ms is the absolute timestamp tunnel.lock_htlc expects.
    let now = clock.timestamp_ms();
    let timeouts = hop::create_cascading_timeouts(
        base_timeout_ms,
        hop_count,
        DEFAULT_CORRIDOR_TIMEOUT_MS,
    );

    // Create HTLCs for each hop
    let mut current_amount = remittance.amount;
    let mut i = hop_count;

    // Work backwards (recipient to sender) for amounts
    // Each hop adds its fee
    while (i > 0) {
        i = i - 1;
        let hop_ref = hop::route_get_hop(route, i);
        let fee = hop::hop_fee(hop_ref);

        // Amount at this hop includes fees for subsequent hops
        let htlc_amount = if (i == hop_count - 1) {
            remittance.amount
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
            remittance.payment_hash,
            htlc_amount,
            sender_addr,
            hop::hop_node_address(hop_ref),
            now + timeouts[i],
        );

        remittance.htlcs.push_back(htlc);
    };

    // Reverse HTLCs to be in forward order
    remittance.htlcs.reverse();

    hop::activate_route(&mut remittance.route);
    remittance.status = REMITTANCE_IN_FLIGHT;

    event::emit(RemittanceInitiated {
        sender: hop::route_sender(&remittance.route),
        receiver: hop::route_receiver(&remittance.route),
        amount: remittance.amount,
        hop_count,
    });
}

/// Recipient claims the remittance with preimage.
/// Only the route recipient can claim the remittance.
public fun claim_remittance(
    remittance: &mut Remittance,
    preimage: vector<u8>,
    ctx: &TxContext,
): bool {
    assert!(ctx.sender() == hop::route_receiver(&remittance.route), ENotAuthorized);
    assert!(remittance.status == REMITTANCE_IN_FLIGHT, EInvalidState);

    // Verify preimage matches payment hash
    let computed_hash = hop::create_payment_hash(&preimage);
    if (computed_hash != remittance.payment_hash) {
        return false
    };

    // Claim all HTLCs with the preimage
    let htlc_count = remittance.htlcs.length();
    let mut i = htlc_count;

    // Claim backwards (recipient to sender)
    while (i > 0) {
        i = i - 1;
        let htlc = &mut remittance.htlcs[i];
        let claimed = hop::claim_htlc_internal(htlc, preimage);
        assert!(claimed, EInvalidState);
    };

    remittance.preimage = preimage;
    remittance.settled_count = htlc_count;
    remittance.status = REMITTANCE_SETTLED;
    hop::complete_route(&mut remittance.route);

    event::emit(RemittanceSettled {
        sender: hop::route_sender(&remittance.route),
        receiver: hop::route_receiver(&remittance.route),
        amount: remittance.amount,
        fees: remittance.total_fees,
    });

    true
}

/// Fails the remittance (timeout or error). Only the route sender can fail.
public fun fail_remittance(remittance: &mut Remittance, clock: &Clock, ctx: &TxContext) {
    assert!(ctx.sender() == hop::route_sender(&remittance.route), ENotAuthorized);
    assert!(
        remittance.status == REMITTANCE_CREATED || remittance.status == REMITTANCE_IN_FLIGHT,
        EInvalidState,
    );

    let current_time_ms = clock.timestamp_ms();

    // Expire any pending, past-expiry HTLCs. The route sender drives the
    // unwind across every hop, but intermediate HTLCs have intermediary-node
    // senders, so `expire_htlc` (which is sender-gated) would abort on the
    // first non-sender hop. `expire_htlc_internal` skips that per-HTLC sender
    // check — authorization is already established by the route-sender gate
    // above — and simply no-ops on HTLCs that are not yet expired.
    remittance.htlcs.do_mut!(|htlc| {
        if (hop::htlc_status(htlc) == hop::htlc_status_pending()) {
            hop::expire_htlc_internal(htlc, current_time_ms);
        };
    });

    remittance.status = REMITTANCE_FAILED;
    hop::fail_route(&mut remittance.route);

    event::emit(RemittanceFailed {
        sender: hop::route_sender(&remittance.route),
        receiver: hop::route_receiver(&remittance.route),
        amount: remittance.amount,
    });
}

/// Creates a receipt for a settled remittance, surfacing the source and
/// destination amounts derived from the quoted FX rate.
public fun create_remittance_receipt(
    remittance: &Remittance,
    source_currency: vector<u8>,
    dest_currency: vector<u8>,
    fx_rate: u64,
    completed_at: u64,
): RemittanceReceipt {
    assert!(remittance.status == REMITTANCE_SETTLED, EInvalidState);

    RemittanceReceipt {
        remittance_id: remittance.remittance_id,
        preimage: remittance.preimage,
        source_amount: remittance.amount,
        dest_amount: quote_dest_amount(remittance.amount, fx_rate),
        source_currency,
        dest_currency,
        fx_rate,
        fees: remittance.total_fees,
        sender: hop::route_sender(&remittance.route),
        receiver: hop::route_receiver(&remittance.route),
        completed_at,
    }
}

// ============================================
// REMITTANCE ACCESSORS
// ============================================

/// The unique remittance identifier.
public fun remittance_id(remittance: &Remittance): &vector<u8> { &remittance.remittance_id }

/// The payment hash settling every corridor HTLC.
public fun payment_hash(remittance: &Remittance): &vector<u8> { &remittance.payment_hash }

/// The revealed preimage, empty until the remittance settles.
public fun remittance_preimage(remittance: &Remittance): &vector<u8> { &remittance.preimage }

/// The current lifecycle status code.
public fun remittance_status(remittance: &Remittance): u8 { remittance.status }

/// The amount delivered to the recipient.
public fun remittance_amount(remittance: &Remittance): u64 { remittance.amount }

/// The total corridor fees across all hops.
public fun remittance_total_fees(remittance: &Remittance): u64 { remittance.total_fees }

/// The underlying corridor route.
public fun remittance_route(remittance: &Remittance): &hop::Route { &remittance.route }

/// The number of HTLCs set up along the corridor.
public fun remittance_htlc_count(remittance: &Remittance): u64 { remittance.htlcs.length() }

/// The number of HTLCs that have settled.
public fun remittance_settled_count(remittance: &Remittance): u64 { remittance.settled_count }

// ============================================
// RECEIPT ACCESSORS
// ============================================

/// The remittance ID this receipt attests to.
public fun receipt_remittance_id(receipt: &RemittanceReceipt): &vector<u8> {
    &receipt.remittance_id
}

/// The preimage proving settlement.
public fun receipt_preimage(receipt: &RemittanceReceipt): &vector<u8> { &receipt.preimage }

/// The amount sent in the source currency.
public fun receipt_source_amount(receipt: &RemittanceReceipt): u64 { receipt.source_amount }

/// The amount delivered in the destination currency.
public fun receipt_dest_amount(receipt: &RemittanceReceipt): u64 { receipt.dest_amount }

/// The source currency ISO code.
public fun receipt_source_currency(receipt: &RemittanceReceipt): &vector<u8> {
    &receipt.source_currency
}

/// The destination currency ISO code.
public fun receipt_dest_currency(receipt: &RemittanceReceipt): &vector<u8> {
    &receipt.dest_currency
}

/// The quoted FX rate scaled by FX_RATE_SCALE.
public fun receipt_fx_rate(receipt: &RemittanceReceipt): u64 { receipt.fx_rate }

/// The fees paid for the remittance.
public fun receipt_fees(receipt: &RemittanceReceipt): u64 { receipt.fees }

/// The sender of the remittance.
public fun receipt_sender(receipt: &RemittanceReceipt): address { receipt.sender }

/// The recipient of the remittance.
public fun receipt_receiver(receipt: &RemittanceReceipt): address { receipt.receiver }

/// The settlement timestamp in milliseconds.
public fun receipt_completed_at(receipt: &RemittanceReceipt): u64 { receipt.completed_at }

// ============================================
// UTILITY FUNCTIONS
// ============================================

/// Calculates total amount needed for a remittance (amount + fees)
public fun calculate_total_needed(remittance: &Remittance): u64 {
    remittance.amount + remittance.total_fees
}

/// Checks if the remittance settled successfully
public fun is_remittance_successful(remittance: &Remittance): bool {
    remittance.status == REMITTANCE_SETTLED
}

/// Checks if the remittance can be retried
public fun can_retry(remittance: &Remittance): bool {
    remittance.status == REMITTANCE_FAILED
}

// ============================================
// ON-CHAIN HTLC ROUTING (REAL FUND MOVEMENT)
// ============================================
//
// Everything above operates on `hop::HTLC` value structs: pure off-chain routing
// math that moves no funds. The functions below execute the SAME plan against real
// funded `Tunnel<T>` channels using the tunnel's in-tunnel HTLCs. Each corridor edge
// is an independent, already-funded, active two-party tunnel; the orchestrator locks
// an HTLC per edge (forward), the recipient claims with the preimage, and that
// preimage propagates upstream so each correspondent claims its incoming HTLC —
// moving real `Coin<T>`. On timeout, each locker reclaims via `expire_corridor_htlc`.
// Cascading timeouts make the chain safe exactly as in Lightning; atomicity is
// economic, not transactional.
//
// All on-chain enforcement (32-byte payment hash, amount <= locker balance, the
// `party_a + party_b == balance` invariant, preimage/expiry checks, domain-separated
// HTLC signatures) lives in `tunnel`, not here. This module only binds each plan hop
// to its real tunnel and drives the tunnel primitives.

/// Emitted when a corridor hop's HTLC is locked on-chain.
public struct CorridorHopLocked has copy, drop {
    payment_hash: vector<u8>,
    tunnel_id: ID,
    hop_index: u64,
    amount: u64,
    receiver: address,
}

/// Emitted when a corridor hop's HTLC is claimed on-chain with the preimage.
public struct CorridorHopClaimed has copy, drop {
    payment_hash: vector<u8>,
    tunnel_id: ID,
    hop_index: u64,
}

/// Emitted when a corridor hop's HTLC is reclaimed by its locker after expiry.
public struct CorridorHopExpired has copy, drop {
    payment_hash: vector<u8>,
    tunnel_id: ID,
    hop_index: u64,
}

/// The canonical route label for a funded tunnel. Pass this as a hop's `tunnel_id`
/// when building the route so the on-chain orchestration can bind the hop to the real
/// channel.
public fun corridor_tunnel_id<T>(tunnel: &Tunnel<T>): vector<u8> {
    object::id(tunnel).to_bytes()
}

/// Asserts the route hop at `hop_index` references `tunnel`.
fun assert_hop_bound<T>(remittance: &Remittance, tunnel: &Tunnel<T>, hop_index: u64) {
    let route = &remittance.route;
    assert!(hop_index < hop::route_hop_count(route), EInvalidHop);
    let hop_ref = hop::route_get_hop(route, hop_index);
    assert!(*hop::hop_tunnel_id(hop_ref) == corridor_tunnel_id(tunnel), EHopTunnelMismatch);
}

/// Locks the on-chain HTLC for hop `hop_index` in its funded tunnel, carving the hop
/// amount out of the locker's tunnel balance. The route hop must reference this tunnel
/// and the counterparty must have signed the HTLC terms. The same payment hash is
/// reused on every edge so one preimage settles the whole corridor.
public fun lock_corridor_htlc<T>(
    remittance: &Remittance,
    tunnel: &mut Tunnel<T>,
    hop_index: u64,
    counterparty_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(remittance.status == REMITTANCE_IN_FLIGHT, EInvalidState);
    assert_hop_bound(remittance, tunnel, hop_index);

    let htlc = &remittance.htlcs[hop_index];
    let amount = hop::htlc_amount(htlc);
    let receiver = hop::htlc_receiver(htlc);
    let expiry_ms = hop::htlc_expiry_ms(htlc);
    let tunnel_id = object::id(tunnel);

    tunnel.lock_htlc(
        remittance.payment_hash,
        amount,
        receiver,
        expiry_ms,
        counterparty_sig,
        clock,
        ctx,
    );

    event::emit(CorridorHopLocked {
        payment_hash: remittance.payment_hash,
        tunnel_id,
        hop_index,
        amount,
        receiver,
    });
}

/// Claims the on-chain HTLC for hop `hop_index` with the preimage, transferring the
/// hop amount to the receiver. Reveals the preimage so the upstream correspondent can
/// claim its own incoming HTLC. Only the HTLC receiver can call it (enforced by the
/// tunnel).
public fun claim_corridor_htlc<T>(
    remittance: &Remittance,
    tunnel: &mut Tunnel<T>,
    hop_index: u64,
    preimage: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_hop_bound(remittance, tunnel, hop_index);
    let tunnel_id = object::id(tunnel);

    tunnel.claim_htlc_in_tunnel(remittance.payment_hash, preimage, clock, ctx);

    event::emit(CorridorHopClaimed {
        payment_hash: remittance.payment_hash,
        tunnel_id,
        hop_index,
    });
}

/// Reclaims the on-chain HTLC for hop `hop_index` after its expiry, returning the
/// locked amount to the locker. Only the HTLC sender can call it (enforced by the
/// tunnel). Cascading timeouts guarantee an upstream locker can always reclaim.
public fun expire_corridor_htlc<T>(
    remittance: &Remittance,
    tunnel: &mut Tunnel<T>,
    hop_index: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_hop_bound(remittance, tunnel, hop_index);
    let tunnel_id = object::id(tunnel);

    tunnel.expire_htlc_in_tunnel(remittance.payment_hash, clock, ctx);

    event::emit(CorridorHopExpired {
        payment_hash: remittance.payment_hash,
        tunnel_id,
        hop_index,
    });
}

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_for_testing(remittance: Remittance) {
    let Remittance { id, .. } = remittance;
    id.delete();
}

/// Locks a corridor hop's HTLC without a counterparty signature, exercising the real
/// on-chain HTLC fund movement. Signature verification is covered by the signature
/// suite.
#[test_only]
public fun lock_corridor_htlc_no_sig_for_testing<T>(
    remittance: &Remittance,
    tunnel: &mut Tunnel<T>,
    hop_index: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(remittance.status == REMITTANCE_IN_FLIGHT, EInvalidState);
    assert_hop_bound(remittance, tunnel, hop_index);
    let htlc = &remittance.htlcs[hop_index];
    tunnel.lock_htlc_no_sig_for_testing(
        remittance.payment_hash,
        hop::htlc_amount(htlc),
        hop::htlc_receiver(htlc),
        hop::htlc_expiry_ms(htlc),
        clock,
        ctx,
    );
}
