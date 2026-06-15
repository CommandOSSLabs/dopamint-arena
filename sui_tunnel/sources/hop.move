/// Module: hop
///
/// Multi-hop routing for the Sui Tunnel Framework.
/// Enables Lightning Network-style payment routing through multiple tunnels.
///
/// ## Architecture
///
/// ```
/// ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
/// │  Alice  │───►│  Bob    │───►│ Charlie │───►│  Dave   │
/// │ (Sender)│    │ (Hop 1) │    │ (Hop 2) │    │(Receiver│
/// └─────────┘    └─────────┘    └─────────┘    └─────────┘
///      │              │              │              │
///      └──────────────┴──────────────┴──────────────┘
///                        Route
/// ```
///
/// ## Key Concepts
///
/// - **Hop**: A single step in a multi-hop route (one tunnel)
/// - **Route**: A sequence of hops from sender to receiver
/// - **HTLC**: Hash Time-Locked Contract for atomic transfers
/// - **Timeout Cascade**: Each hop has decreasing timeouts for safety
///
/// ## Usage Example
///
/// ```move
/// use sui_tunnel::hop;
///
/// // Create a route through multiple tunnels
/// let route = hop::create_route(sender, receiver, amount);
/// hop::add_hop(&mut route, tunnel_1_id, node_1, fee_1, timeout_1);
/// hop::add_hop(&mut route, tunnel_2_id, node_2, fee_2, timeout_2);
///
/// // Create HTLC
/// let htlc = hop::create_htlc(payment_hash, amount, expiry);
/// ```
///
/// ## Security Notes
///
/// - Timeouts must decrease along the route to prevent theft
/// - Fees must be agreed upon before routing
/// - HTLCs should be settled atomically across all hops
///
/// ## Architecture Note
///
/// This module represents **off-chain routing node logic**. The Route, Hop,
/// and HTLC structs model the data structures that routing nodes maintain
/// off-chain to coordinate multi-hop payments. They are NOT enforced on-chain
/// during disputes — on-chain dispute resolution uses the core `tunnel.move`
/// state channel mechanism (signed state commitments with balance distributions).
///
/// For full on-chain HTLC enforcement during disputes, a dedicated HTLC_Tunnel
/// variant would be needed where the StateCommitment includes pending HTLCs
/// and the force_close logic resolves them individually. This module provides
/// the building blocks for that, but does not implement on-chain resolution.
module sui_tunnel::hop;

use sui::event;
use sui::hash;
use sui_tunnel::signature;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EInvalidVersion: vector<u8> = b"The object version does not match the current module version.";

#[error]
const EInvalidTimeout: vector<u8> = b"The timeout value is invalid.";

#[error]
const EInvalidHop: vector<u8> = b"The hop is invalid.";

#[error]
const EMaxHopsExceeded: vector<u8> = b"The maximum number of hops has been exceeded.";

// Soft validation result codes returned in RouteValidation.error_code.
// These are reported in a struct (never used as abort codes); the numeric
// values intentionally mirror the canonical error codes in sui_tunnel::errors.
const RV_INVALID_PARAMETER: u64 = 2;
const RV_INVALID_TIMEOUT: u64 = 510;
const RV_INVALID_HOP: u64 = 700;
const RV_MAX_HOPS_EXCEEDED: u64 = 707;

// ============================================
// CONSTANTS
// ============================================

/// Current struct version for upgrade compatibility
const CURRENT_VERSION: u64 = 1;

/// Maximum number of hops in a route
const MAX_HOPS: u64 = 20;

/// Minimum timeout delta between hops (in milliseconds)
const MIN_TIMEOUT_DELTA_MS: u64 = 60000; // 1 minute

/// Default base fee for routing (in smallest unit)
const DEFAULT_BASE_FEE: u64 = 1000;

/// Default fee rate (per million)
const DEFAULT_FEE_RATE: u64 = 100; // 0.01%

/// HTLC status: Pending (not yet claimed or expired)
const HTLC_STATUS_PENDING: u8 = 0;

/// HTLC status: Claimed (preimage revealed)
const HTLC_STATUS_CLAIMED: u8 = 1;

/// HTLC status: Expired (timeout reached without claim)
const HTLC_STATUS_EXPIRED: u8 = 2;

/// HTLC status: Cancelled (by mutual agreement)
const HTLC_STATUS_CANCELLED: u8 = 3;

/// Route status: Planning
const ROUTE_STATUS_PLANNING: u8 = 0;

/// Route status: Active (HTLCs created)
const ROUTE_STATUS_ACTIVE: u8 = 1;

/// Route status: Completed (all HTLCs claimed)
const ROUTE_STATUS_COMPLETED: u8 = 2;

/// Route status: Failed (timeout or cancellation)
const ROUTE_STATUS_FAILED: u8 = 3;

// One hour in milliseconds
// const ONE_HOUR_MS: u64 = 3600000;

// ============================================
// STRUCTS
// ============================================

/// A single hop in a multi-hop route
public struct Hop has copy, drop, store {
    /// Tunnel ID for this hop
    tunnel_id: vector<u8>,
    /// Address of the node receiving at this hop
    node_address: address,
    /// Fee charged by this node for routing
    fee: u64,
    /// Timeout for this hop's HTLC (absolute timestamp)
    timeout_ms: u64,
    /// Index in the route (0 = first hop)
    index: u64,
}

/// A complete route from sender to receiver
public struct Route has copy, drop, store {
    /// Unique identifier for this route
    id: vector<u8>,
    /// Sender address
    sender: address,
    /// Final receiver address
    receiver: address,
    /// Amount to be transferred (before fees)
    amount: u64,
    /// List of hops in order
    hops: vector<Hop>,
    /// Total fees across all hops
    total_fees: u64,
    /// Current status
    status: u8,
    /// Creation timestamp
    created_at: u64,
}

/// Hash Time-Locked Contract for atomic transfers
public struct HTLC has drop, store {
    /// Unique identifier
    id: vector<u8>,
    /// Hash of the preimage (payment hash)
    payment_hash: vector<u8>,
    /// Amount locked
    amount: u64,
    /// Sender (who locked the funds)
    sender: address,
    /// Receiver (who can claim with preimage)
    receiver: address,
    /// Expiry timestamp (after which sender can reclaim)
    expiry_ms: u64,
    /// Current status
    status: u8,
    /// Optional: preimage once revealed
    preimage: vector<u8>,
}

/// Fee policy for a routing node.
///
/// Note: `min_timeout_delta_ms`, `min_htlc`, and `max_htlc` are advisory data —
/// they are NOT auto-enforced by `add_hop` or `validate_route`. Callers must
/// consult them (e.g. via `is_amount_acceptable`) to enforce the limits.
/// (Known limitation.)
public struct FeePolicy has copy, drop, store {
    /// Base fee charged per transaction
    base_fee: u64,
    /// Fee rate in parts per million
    fee_rate_ppm: u64,
    /// Minimum HTLC amount accepted
    min_htlc: u64,
    /// Maximum HTLC amount accepted
    max_htlc: u64,
    /// Minimum timeout delta required
    min_timeout_delta_ms: u64,
}

/// Information about a routing node
public struct RoutingNode has copy, drop, store {
    /// Struct version for upgrade compatibility
    version: u64,
    /// Node address
    address: address,
    /// Connected tunnel IDs
    tunnel_ids: vector<vector<u8>>,
    /// Fee policy
    fee_policy: FeePolicy,
    /// Whether the node is currently active
    active: bool,
    /// Total routed volume (for reputation)
    total_routed: u64,
    /// Successful routes
    successful_routes: u64,
    /// Failed routes
    failed_routes: u64,
}

/// Result of route validation
public struct RouteValidation has copy, drop, store {
    /// Whether the route is valid
    valid: bool,
    /// Error code if invalid (0 if valid)
    error_code: u64,
    /// Description of issue
    error_message: vector<u8>,
    /// Total amount needed (including all fees)
    total_amount_needed: u64,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a route is activated
public struct RouteActivated has copy, drop {
    sender: address,
    receiver: address,
    amount: u64,
    hop_count: u64,
}

/// Emitted when a route completes successfully
public struct RouteCompleted has copy, drop {
    sender: address,
    receiver: address,
    amount: u64,
}

/// Emitted when a route fails
public struct RouteFailed has copy, drop {
    sender: address,
    receiver: address,
    amount: u64,
}

/// Emitted when an HTLC is claimed with preimage
public struct HTLCClaimed has copy, drop {
    amount: u64,
    sender: address,
    receiver: address,
}

/// Emitted when an HTLC expires
public struct HTLCExpired has copy, drop {
    amount: u64,
    sender: address,
    receiver: address,
}

// ============================================
// PUBLIC GETTER FUNCTIONS FOR CONSTANTS
// ============================================

/// Returns the maximum number of hops allowed
public fun max_hops(): u64 { MAX_HOPS }

/// Returns the minimum timeout delta between hops
public fun min_timeout_delta_ms(): u64 { MIN_TIMEOUT_DELTA_MS }

/// Returns the default base fee
public fun default_base_fee(): u64 { DEFAULT_BASE_FEE }

/// Returns the default fee rate (per million)
public fun default_fee_rate(): u64 { DEFAULT_FEE_RATE }

/// Returns the HTLC pending status
public fun htlc_status_pending(): u8 { HTLC_STATUS_PENDING }

/// Returns the HTLC claimed status
public fun htlc_status_claimed(): u8 { HTLC_STATUS_CLAIMED }

/// Returns the HTLC expired status
public fun htlc_status_expired(): u8 { HTLC_STATUS_EXPIRED }

/// Returns the HTLC cancelled status
public fun htlc_status_cancelled(): u8 { HTLC_STATUS_CANCELLED }

/// Returns the route planning status
public fun route_status_planning(): u8 { ROUTE_STATUS_PLANNING }

/// Returns the route active status
public fun route_status_active(): u8 { ROUTE_STATUS_ACTIVE }

/// Returns the route completed status
public fun route_status_completed(): u8 { ROUTE_STATUS_COMPLETED }

/// Returns the route failed status
public fun route_status_failed(): u8 { ROUTE_STATUS_FAILED }

// ============================================
// HOP FUNCTIONS
// ============================================

/// Creates a new hop
public fun create_hop(
    tunnel_id: vector<u8>,
    node_address: address,
    fee: u64,
    timeout_ms: u64,
    index: u64,
): Hop {
    Hop {
        tunnel_id,
        node_address,
        fee,
        timeout_ms,
        index,
    }
}

/// Gets the tunnel ID from a hop
public fun hop_tunnel_id(hop: &Hop): &vector<u8> { &hop.tunnel_id }

/// Gets the node address from a hop
public fun hop_node_address(hop: &Hop): address { hop.node_address }

/// Gets the fee from a hop
public fun hop_fee(hop: &Hop): u64 { hop.fee }

/// Gets the timeout from a hop
public fun hop_timeout_ms(hop: &Hop): u64 { hop.timeout_ms }

/// Gets the index from a hop
public fun hop_index(hop: &Hop): u64 { hop.index }

// ============================================
// ROUTE FUNCTIONS
// ============================================

/// Creates a route ID from parameters
public fun create_route_id(
    sender: address,
    receiver: address,
    amount: u64,
    timestamp: u64,
): vector<u8> {
    let mut data = sender.to_bytes();
    data.append(receiver.to_bytes());
    data.append(signature::u64_to_be_bytes(amount));
    data.append(signature::u64_to_be_bytes(timestamp));
    hash::blake2b256(&data)
}

/// Creates a new route
public fun create_route(sender: address, receiver: address, amount: u64, timestamp: u64): Route {
    Route {
        id: create_route_id(sender, receiver, amount, timestamp),
        sender,
        receiver,
        amount,
        hops: vector[],
        total_fees: 0,
        status: ROUTE_STATUS_PLANNING,
        created_at: timestamp,
    }
}

/// Adds a hop to a route
public fun add_hop(
    route: &mut Route,
    tunnel_id: vector<u8>,
    node_address: address,
    fee: u64,
    timeout_ms: u64,
) {
    assert!(route.status == ROUTE_STATUS_PLANNING, EInvalidHop);
    assert!(route.hops.length() < MAX_HOPS, EMaxHopsExceeded);

    let index = route.hops.length();
    let hop = create_hop(tunnel_id, node_address, fee, timeout_ms, index);

    route.hops.push_back(hop);
    route.total_fees = route.total_fees + fee;
}

/// Validates a route for correctness
public fun validate_route(route: &Route): RouteValidation {
    // Check minimum hops
    if (route.hops.length() == 0) {
        return RouteValidation {
            valid: false,
            error_code: RV_INVALID_HOP,
            error_message: b"Route must have at least one hop",
            total_amount_needed: 0,
        }
    };

    // Check maximum hops
    if (route.hops.length() > MAX_HOPS) {
        return RouteValidation {
            valid: false,
            error_code: RV_MAX_HOPS_EXCEEDED,
            error_message: b"Route exceeds maximum hops",
            total_amount_needed: 0,
        }
    };

    // Check timeout cascade (each hop should have smaller timeout than previous)
    let num_hops = route.hops.length();
    if (num_hops > 1) {
        let mut i = 1;
        while (i < num_hops) {
            let prev_hop = &route.hops[i - 1];
            let curr_hop = &route.hops[i];

            // Current timeout should be less than previous
            if (curr_hop.timeout_ms >= prev_hop.timeout_ms) {
                return RouteValidation {
                    valid: false,
                    error_code: RV_INVALID_TIMEOUT,
                    error_message: b"Timeouts must decrease along route",
                    total_amount_needed: 0,
                }
            };

            // Check minimum delta
            let delta = prev_hop.timeout_ms - curr_hop.timeout_ms;
            if (delta < MIN_TIMEOUT_DELTA_MS) {
                return RouteValidation {
                    valid: false,
                    error_code: RV_INVALID_TIMEOUT,
                    error_message: b"Timeout delta too small",
                    total_amount_needed: 0,
                }
            };

            i = i + 1;
        };
    };

    // Check that final hop goes to receiver
    let last_hop = &route.hops[num_hops - 1];
    if (last_hop.node_address != route.receiver) {
        return RouteValidation {
            valid: false,
            error_code: RV_INVALID_HOP,
            error_message: b"Final hop must go to receiver",
            total_amount_needed: 0,
        }
    };

    // Calculate total amount needed. Compute in u128 so the add cannot abort on
    // overflow — validate_route reports validity via the result struct rather
    // than aborting, so an overflowing total is surfaced as an INVALID result.
    let total_u128 = (route.amount as u128) + (route.total_fees as u128);
    if (total_u128 > (std::u64::max_value!() as u128)) {
        return RouteValidation {
            valid: false,
            error_code: RV_INVALID_PARAMETER,
            error_message: b"Total amount (amount + fees) overflows u64",
            total_amount_needed: 0,
        }
    };
    let total = total_u128 as u64;

    RouteValidation {
        valid: true,
        error_code: 0,
        error_message: b"",
        total_amount_needed: total,
    }
}

/// Activates a route (marks HTLCs as created)
public fun activate_route(route: &mut Route) {
    assert!(route.status == ROUTE_STATUS_PLANNING, EInvalidHop);
    route.status = ROUTE_STATUS_ACTIVE;
    event::emit(RouteActivated {
        sender: route.sender,
        receiver: route.receiver,
        amount: route.amount,
        hop_count: route.hops.length(),
    });
}

/// Marks a route as completed
public fun complete_route(route: &mut Route) {
    assert!(route.status == ROUTE_STATUS_ACTIVE, EInvalidHop);
    route.status = ROUTE_STATUS_COMPLETED;
    event::emit(RouteCompleted {
        sender: route.sender,
        receiver: route.receiver,
        amount: route.amount,
    });
}

/// Marks a route as failed
public fun fail_route(route: &mut Route) {
    assert!(
        route.status == ROUTE_STATUS_PLANNING || route.status == ROUTE_STATUS_ACTIVE,
        EInvalidHop,
    );
    route.status = ROUTE_STATUS_FAILED;
    event::emit(RouteFailed {
        sender: route.sender,
        receiver: route.receiver,
        amount: route.amount,
    });
}

// Route accessors
public fun route_id(route: &Route): &vector<u8> { &route.id }

public fun route_sender(route: &Route): address { route.sender }

public fun route_receiver(route: &Route): address { route.receiver }

public fun route_amount(route: &Route): u64 { route.amount }

public fun route_hops(route: &Route): &vector<Hop> { &route.hops }

public fun route_hop_count(route: &Route): u64 { route.hops.length() }

public fun route_total_fees(route: &Route): u64 { route.total_fees }

public fun route_status(route: &Route): u8 { route.status }

public fun route_created_at(route: &Route): u64 { route.created_at }

/// Gets a specific hop from a route
public fun route_get_hop(route: &Route, index: u64): &Hop {
    assert!(index < route.hops.length(), EInvalidHop);
    &route.hops[index]
}

// ============================================
// HTLC FUNCTIONS
// ============================================
//
// Note: the state-transition helpers below (claim_htlc[_internal],
// expire_htlc[_internal], cancel_htlc) return a bool indicating success — a
// `false` means the transition did NOT happen (e.g. HTLC not pending, preimage
// mismatch, or not yet past expiry). Callers MUST check the returned bool and
// not assume the HTLC changed state.

/// Creates a payment hash from a preimage
public fun create_payment_hash(preimage: &vector<u8>): vector<u8> {
    hash::blake2b256(preimage)
}

/// Creates an HTLC ID
public fun create_htlc_id(
    payment_hash: &vector<u8>,
    sender: address,
    receiver: address,
    amount: u64,
): vector<u8> {
    let mut data = *payment_hash;
    data.append(sender.to_bytes());
    data.append(receiver.to_bytes());
    data.append(signature::u64_to_be_bytes(amount));
    hash::blake2b256(&data)
}

/// Creates a new HTLC
public fun create_htlc(
    payment_hash: vector<u8>,
    amount: u64,
    sender: address,
    receiver: address,
    expiry_ms: u64,
): HTLC {
    HTLC {
        id: create_htlc_id(&payment_hash, sender, receiver, amount),
        payment_hash,
        amount,
        sender,
        receiver,
        expiry_ms,
        status: HTLC_STATUS_PENDING,
        preimage: vector[],
    }
}

/// Verifies a preimage matches the payment hash
public fun verify_preimage(htlc: &HTLC, preimage: &vector<u8>): bool {
    let computed_hash = create_payment_hash(preimage);
    computed_hash == htlc.payment_hash
}

/// Claims an HTLC with the preimage.
/// Only the designated receiver can claim to prevent front-running attacks
/// where an observer could race to claim funds after seeing the preimage on-chain.
public fun claim_htlc(htlc: &mut HTLC, preimage: vector<u8>, ctx: &TxContext): bool {
    // Only the designated receiver can claim
    assert!(ctx.sender() == htlc.receiver, ENotAuthorized);
    claim_htlc_internal(htlc, preimage)
}

/// Claims an HTLC with the preimage, without receiver authorization.
/// For use by package-internal modules (e.g., multi-hop payment) where
/// authorization is handled at a higher level (the calling function
/// verifies the caller is the route receiver).
public(package) fun claim_htlc_internal(htlc: &mut HTLC, preimage: vector<u8>): bool {
    // Must be pending
    if (htlc.status != HTLC_STATUS_PENDING) {
        return false
    };

    // Verify preimage
    if (!verify_preimage(htlc, &preimage)) {
        return false
    };

    htlc.status = HTLC_STATUS_CLAIMED;
    htlc.preimage = preimage;
    event::emit(HTLCClaimed {
        amount: htlc.amount,
        sender: htlc.sender,
        receiver: htlc.receiver,
    });
    true
}

/// Expires an HTLC (sender can reclaim after timeout)
public fun expire_htlc(htlc: &mut HTLC, current_time_ms: u64, ctx: &TxContext): bool {
    // Only the HTLC sender can expire (reclaim funds)
    assert!(ctx.sender() == htlc.sender, ENotAuthorized);

    // Must be pending
    if (htlc.status != HTLC_STATUS_PENDING) {
        return false
    };

    // Must be past expiry
    if (current_time_ms < htlc.expiry_ms) {
        return false
    };

    htlc.status = HTLC_STATUS_EXPIRED;
    event::emit(HTLCExpired {
        amount: htlc.amount,
        sender: htlc.sender,
        receiver: htlc.receiver,
    });
    true
}

/// Expires an HTLC without the sender authorization check.
/// For use by package-internal modules unwinding every hop's HTLC along a route
/// (e.g. multi-hop failure handling): the route owner can reclaim funds on each
/// hop after timeout. Authorization is handled at a higher level (the calling
/// function verifies the caller owns the route). Returns true on a successful
/// expiry transition, false if the HTLC is not pending or not yet past expiry.
public(package) fun expire_htlc_internal(htlc: &mut HTLC, current_time_ms: u64): bool {
    // Must be pending
    if (htlc.status != HTLC_STATUS_PENDING) {
        return false
    };

    // Must be past expiry
    if (current_time_ms < htlc.expiry_ms) {
        return false
    };

    htlc.status = HTLC_STATUS_EXPIRED;
    event::emit(HTLCExpired {
        amount: htlc.amount,
        sender: htlc.sender,
        receiver: htlc.receiver,
    });
    true
}

/// Cancels an HTLC (by sender or receiver)
public fun cancel_htlc(htlc: &mut HTLC, ctx: &TxContext): bool {
    // Only sender or receiver can cancel
    assert!(ctx.sender() == htlc.sender || ctx.sender() == htlc.receiver, ENotAuthorized);

    // Must be pending
    if (htlc.status != HTLC_STATUS_PENDING) {
        return false
    };

    htlc.status = HTLC_STATUS_CANCELLED;
    true
}

/// Checks if an HTLC is claimable
public fun is_htlc_claimable(htlc: &HTLC, current_time_ms: u64): bool {
    htlc.status == HTLC_STATUS_PENDING && current_time_ms < htlc.expiry_ms
}

/// Checks if an HTLC is expired
public fun is_htlc_expired(htlc: &HTLC, current_time_ms: u64): bool {
    htlc.status == HTLC_STATUS_PENDING && current_time_ms >= htlc.expiry_ms
}

// HTLC accessors
public fun htlc_id(htlc: &HTLC): &vector<u8> { &htlc.id }

public fun htlc_payment_hash(htlc: &HTLC): &vector<u8> { &htlc.payment_hash }

public fun htlc_amount(htlc: &HTLC): u64 { htlc.amount }

public fun htlc_sender(htlc: &HTLC): address { htlc.sender }

public fun htlc_receiver(htlc: &HTLC): address { htlc.receiver }

public fun htlc_expiry_ms(htlc: &HTLC): u64 { htlc.expiry_ms }

public fun htlc_status(htlc: &HTLC): u8 { htlc.status }

public fun htlc_preimage(htlc: &HTLC): &vector<u8> { &htlc.preimage }

// ============================================
// FEE POLICY FUNCTIONS
// ============================================

/// Creates a default fee policy
public fun default_fee_policy(): FeePolicy {
    FeePolicy {
        base_fee: DEFAULT_BASE_FEE,
        fee_rate_ppm: DEFAULT_FEE_RATE,
        min_htlc: 1000,
        max_htlc: 1_000_000_000_000, // 1 trillion
        min_timeout_delta_ms: MIN_TIMEOUT_DELTA_MS,
    }
}

/// Creates a custom fee policy
public fun create_fee_policy(
    base_fee: u64,
    fee_rate_ppm: u64,
    min_htlc: u64,
    max_htlc: u64,
    min_timeout_delta_ms: u64,
): FeePolicy {
    assert!(min_htlc <= max_htlc, EInvalidParameter);
    assert!(min_timeout_delta_ms >= MIN_TIMEOUT_DELTA_MS, EInvalidTimeout);

    FeePolicy {
        base_fee,
        fee_rate_ppm,
        min_htlc,
        max_htlc,
        min_timeout_delta_ms,
    }
}

/// Calculates fee for a given amount
public fun calculate_fee(policy: &FeePolicy, amount: u64): u64 {
    // Compute the proportional fee fully in u128 (avoids overflow on the
    // multiply) with a single outer cast back to u64; the u128 literal divisor
    // keeps `/` unambiguous relative to `as` operator precedence.
    let proportional_fee =
        (((amount as u128) * (policy.fee_rate_ppm as u128)) / 1_000_000u128) as u64;
    policy.base_fee + proportional_fee
}

/// Checks if an amount is within policy limits
public fun is_amount_acceptable(policy: &FeePolicy, amount: u64): bool {
    amount >= policy.min_htlc && amount <= policy.max_htlc
}

// Fee policy accessors
public fun policy_base_fee(policy: &FeePolicy): u64 { policy.base_fee }

public fun policy_fee_rate_ppm(policy: &FeePolicy): u64 { policy.fee_rate_ppm }

public fun policy_min_htlc(policy: &FeePolicy): u64 { policy.min_htlc }

public fun policy_max_htlc(policy: &FeePolicy): u64 { policy.max_htlc }

public fun policy_min_timeout_delta_ms(policy: &FeePolicy): u64 { policy.min_timeout_delta_ms }

// ============================================
// ROUTING NODE FUNCTIONS
// ============================================

/// Creates a new routing node
public fun create_routing_node(address: address, fee_policy: FeePolicy): RoutingNode {
    RoutingNode {
        version: CURRENT_VERSION,
        address,
        tunnel_ids: vector[],
        fee_policy,
        active: true,
        total_routed: 0,
        successful_routes: 0,
        failed_routes: 0,
    }
}

/// Get the current version constant
public fun current_version(): u64 { CURRENT_VERSION }

/// Get a node's version
public fun node_version(node: &RoutingNode): u64 { node.version }

/// Assert that a node is at the current version
public fun assert_current_version(node: &RoutingNode) {
    assert!(node.version == CURRENT_VERSION, EInvalidVersion);
}

/// Adds a tunnel to a routing node
public fun add_tunnel_to_node(node: &mut RoutingNode, tunnel_id: vector<u8>, ctx: &TxContext) {
    assert!(ctx.sender() == node.address, ENotAuthorized);
    node.tunnel_ids.push_back(tunnel_id);
}

/// Removes a tunnel from a routing node
public fun remove_tunnel_from_node(
    node: &mut RoutingNode,
    tunnel_id: &vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == node.address, ENotAuthorized);
    let len = node.tunnel_ids.length();
    let mut i = 0;
    while (i < len) {
        if (&node.tunnel_ids[i] == tunnel_id) {
            node.tunnel_ids.swap_remove(i);
            return
        };
        i = i + 1;
    };
}

/// Records a successful route
public fun record_successful_route(node: &mut RoutingNode, amount: u64, ctx: &TxContext) {
    assert!(ctx.sender() == node.address, ENotAuthorized);
    node.total_routed = node.total_routed + amount;
    node.successful_routes = node.successful_routes + 1;
}

/// Records a failed route
public fun record_failed_route(node: &mut RoutingNode, ctx: &TxContext) {
    assert!(ctx.sender() == node.address, ENotAuthorized);
    node.failed_routes = node.failed_routes + 1;
}

/// Activates a routing node
public fun activate_node(node: &mut RoutingNode, ctx: &TxContext) {
    assert!(ctx.sender() == node.address, ENotAuthorized);
    node.active = true;
}

/// Deactivates a routing node
public fun deactivate_node(node: &mut RoutingNode, ctx: &TxContext) {
    assert!(ctx.sender() == node.address, ENotAuthorized);
    node.active = false;
}

/// Updates a node's fee policy
public fun update_node_fee_policy(node: &mut RoutingNode, new_policy: FeePolicy, ctx: &TxContext) {
    assert!(ctx.sender() == node.address, ENotAuthorized);
    node.fee_policy = new_policy;
}

// Routing node accessors
public fun node_address(node: &RoutingNode): address { node.address }

public fun node_tunnel_ids(node: &RoutingNode): &vector<vector<u8>> { &node.tunnel_ids }

public fun node_tunnel_count(node: &RoutingNode): u64 { node.tunnel_ids.length() }

public fun node_fee_policy(node: &RoutingNode): &FeePolicy { &node.fee_policy }

public fun node_is_active(node: &RoutingNode): bool { node.active }

public fun node_total_routed(node: &RoutingNode): u64 { node.total_routed }

public fun node_successful_routes(node: &RoutingNode): u64 { node.successful_routes }

public fun node_failed_routes(node: &RoutingNode): u64 { node.failed_routes }

/// Calculates success rate (as percentage * 100, e.g., 9500 = 95.00%)
public fun node_success_rate(node: &RoutingNode): u64 {
    let total = node.successful_routes + node.failed_routes;
    if (total == 0) {
        return 10000 // 100% if no routes yet
    };
    (node.successful_routes * 10000) / total
}

// ============================================
// ROUTE VALIDATION ACCESSORS
// ============================================

public fun validation_valid(v: &RouteValidation): bool { v.valid }

public fun validation_error_code(v: &RouteValidation): u64 { v.error_code }

public fun validation_error_message(v: &RouteValidation): &vector<u8> { &v.error_message }

public fun validation_total_amount(v: &RouteValidation): u64 { v.total_amount_needed }

// ============================================
// UTILITY FUNCTIONS
// ============================================

/// Calculates the total amount needed to send through a route
public fun calculate_total_with_fees(amount: u64, route: &Route): u64 {
    amount + route.total_fees
}

/// Creates timeouts for a route with proper cascade
public fun create_cascading_timeouts(
    base_timeout_ms: u64,
    num_hops: u64,
    delta_ms: u64,
): vector<u64> {
    assert!(num_hops > 0, EInvalidHop);
    assert!(delta_ms >= MIN_TIMEOUT_DELTA_MS, EInvalidTimeout);

    // Guard against u64 underflow inside the loop. The loop subtracts delta_ms once per
    // iteration (num_hops times, including AFTER pushing the last element), so the final
    // `current - delta_ms` requires base_timeout_ms >= num_hops * delta_ms — not
    // (num_hops - 1). Widen to u128 so the multiply cannot overflow before the comparison,
    // returning a centralized error instead of a raw arithmetic abort mid-loop.
    assert!((base_timeout_ms as u128) >= (delta_ms as u128) * (num_hops as u128), EInvalidTimeout);

    let mut timeouts = vector<u64>[];
    let mut current = base_timeout_ms;

    let mut i = 0;
    while (i < num_hops) {
        timeouts.push_back(current);
        current = current - delta_ms;
        i = i + 1;
    };

    timeouts
}

/// Estimates the total fee for a route given hop count and average fee
public fun estimate_route_fee(
    amount: u64,
    hop_count: u64,
    avg_base_fee: u64,
    avg_fee_rate_ppm: u64,
): u64 {
    let total_base = avg_base_fee * hop_count;
    // Compute fully in u128 (the triple product can overflow u64) with a single
    // outer cast; the u128 literal divisor keeps `/` unambiguous vs `as`.
    let total_proportional =
        (
            ((amount as u128) * (avg_fee_rate_ppm as u128) * (hop_count as u128)) / 1_000_000u128,
        ) as u64;
    total_base + total_proportional
}
