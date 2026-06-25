/// Example: Bandwidth Market (Throughput Benefit)
///
/// Demonstrates how tunnels handle unlimited state updates per second.
/// A consumer opens a tunnel with a bandwidth provider and deposits a budget.
/// Per-byte/per-second metering happens off-chain with no throughput limit.
///
/// **Without tunnels:** Each meter reading = on-chain tx, bounded by network TPS
/// **With tunnels:**    Unlimited meter readings per second between the two parties
///
/// Real-world analogy: Like a utility meter that records usage continuously
/// but only sends the bill once at the end of the billing period.
///
/// ## Flow:
/// ```
/// open_session() -> join_as_provider() -> [off-chain: unlimited meter readings] ->
///   record_reading() (optional checkpoint) -> close_session()
/// ```
module sui_tunnel::example_bandwidth_market;

use sui::clock::Clock;
use sui::coin::Coin;
use sui::event;
use sui::hash;
use sui_tunnel::signature;
use sui_tunnel::tunnel::{Self, Tunnel};

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EOverflow: vector<u8> = b"The operation would cause an arithmetic overflow.";

#[error]
const EInvalidSignature: vector<u8> = b"Signature verification failed.";

#[error]
const EInvalidNonce: vector<u8> = b"The nonce is invalid; it must be strictly increasing.";

#[error]
const ENoActiveDispute: vector<u8> = b"There is no active dispute to act on.";

#[error]
const EInsufficientBalance: vector<u8> = b"Insufficient balance for this operation.";

#[error]
const EBalanceMismatch: vector<u8> = b"The balance does not match the expected amount after the operation.";

// ============================================
// CONSTANTS
// ============================================

const SESSION_ACTIVE: u8 = 0;
const SESSION_CLOSED: u8 = 1;
const SESSION_DISPUTED: u8 = 2;
const SESSION_FORCE_CLOSED: u8 = 3;

const DEFAULT_TIMEOUT_MS: u64 = 3600000; // 1 hour

/// 1 MB in bytes
const BYTES_PER_MB: u64 = 1048576;

// ============================================
// STRUCTS
// ============================================

/// Off-chain metering state — accumulated bandwidth usage.
public struct MeterState has copy, drop, store {
    /// Total bytes consumed
    total_bytes: u64,
    /// Total cost in base units
    total_cost: u64,
    /// Number of meter readings taken
    readings_count: u64,
    /// State nonce
    nonce: u64,
}

/// A bandwidth metering session wrapping a Tunnel.
/// Consumer (party A) deposits budget. Provider (party B) serves bandwidth.
/// Per-byte metering happens off-chain with no throughput limit.
public struct BandwidthSession<phantom T> has key, store {
    id: UID,
    /// The underlying tunnel
    tunnel: Tunnel<T>,
    /// Session status
    status: u8,
    /// Latest metering state
    latest_state: MeterState,
    /// Price per megabyte in base units
    rate_per_mb: u64,
}

// ============================================
// EVENTS
// ============================================

public struct BandwidthSessionOpened has copy, drop {
    consumer: address,
    provider: address,
    rate_per_mb: u64,
    budget: u64,
}

public struct BandwidthSessionSettled has copy, drop {
    total_bytes: u64,
    total_cost: u64,
    readings_count: u64,
    consumer_refund: u64,
    provider_earned: u64,
}

// ============================================
// CONSTANT GETTERS
// ============================================

public fun session_active(): u8 { SESSION_ACTIVE }

public fun session_closed(): u8 { SESSION_CLOSED }

public fun session_disputed(): u8 { SESSION_DISPUTED }

public fun session_force_closed(): u8 { SESSION_FORCE_CLOSED }

public fun bytes_per_mb(): u64 { BYTES_PER_MB }

// ============================================
// SESSION LIFECYCLE
// ============================================

/// Consumer opens a bandwidth session with a budget.
public fun open_session<T>(
    consumer_address: address,
    consumer_pk: vector<u8>,
    provider_address: address,
    provider_pk: vector<u8>,
    budget: Coin<T>,
    rate_per_mb: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): BandwidthSession<T> {
    assert!(rate_per_mb > 0, EInvalidParameter);

    let budget_amount = budget.value();

    let mut tun = tunnel::create<T>(
        consumer_address,
        consumer_pk,
        signature::ed25519(),
        provider_address,
        provider_pk,
        signature::ed25519(),
        DEFAULT_TIMEOUT_MS,
        0,
        clock,
        ctx,
    );

    tun.deposit_party_a(budget, clock, ctx);

    event::emit(BandwidthSessionOpened {
        consumer: consumer_address,
        provider: provider_address,
        rate_per_mb,
        budget: budget_amount,
    });

    BandwidthSession {
        id: object::new(ctx),
        tunnel: tun,
        status: SESSION_ACTIVE,
        latest_state: MeterState {
            total_bytes: 0,
            total_cost: 0,
            readings_count: 0,
            nonce: 0,
        },
        rate_per_mb,
    }
}

/// Provider joins with optional collateral.
public fun join_as_provider<T>(
    session: &mut BandwidthSession<T>,
    collateral: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);
    session.tunnel.deposit_party_b(collateral, clock, ctx);
}

// ============================================
// METERING
// ============================================

/// Compute meter reading hash for off-chain signing.
///
/// **Throughput benefit:** This computation happens off-chain and can be
/// performed thousands of times per second. No network TPS limit applies.
public fun compute_meter_hash<T>(
    session: &BandwidthSession<T>,
    total_bytes: u64,
    total_cost: u64,
    readings_count: u64,
    nonce: u64,
): vector<u8> {
    compute_meter_hash_with_id(
        session.tunnel.id(),
        total_bytes,
        total_cost,
        readings_count,
        nonce,
    )
}

/// Compute meter hash from tunnel ID (avoids double-borrow).
public fun compute_meter_hash_with_id(
    tunnel_id: ID,
    total_bytes: u64,
    total_cost: u64,
    readings_count: u64,
    nonce: u64,
): vector<u8> {
    let mut data = b"bandwidth::meter";
    data.append(tunnel_id.to_bytes());
    data.append(signature::u64_to_be_bytes(total_bytes));
    data.append(signature::u64_to_be_bytes(total_cost));
    data.append(signature::u64_to_be_bytes(readings_count));
    data.append(signature::u64_to_be_bytes(nonce));
    hash::blake2b256(&data)
}

/// Calculate cost for a given number of bytes.
/// cost = (bytes * rate_per_mb) / BYTES_PER_MB
public fun calculate_cost(total_bytes: u64, rate_per_mb: u64): u64 {
    // Use u128 to avoid overflow on large byte counts
    let cost = (total_bytes as u128) * (rate_per_mb as u128) / (BYTES_PER_MB as u128);
    assert!(cost <= std::u64::max_value!() as u128, EOverflow);
    (cost as u64)
}

/// Record a meter reading on-chain (optional checkpoint).
/// Most readings happen off-chain — this anchors state for safety.
///
/// **Throughput benefit:** Off-chain, both parties can exchange signed
/// meter readings at any rate (100/s, 1000/s, unlimited). On-chain
/// checkpoints are optional and rare.
public fun record_reading<T>(
    session: &mut BandwidthSession<T>,
    total_bytes: u64,
    total_cost: u64,
    readings_count: u64,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);
    assert!(nonce > session.latest_state.nonce, EInvalidNonce);
    assert!(total_bytes >= session.latest_state.total_bytes, EInvalidParameter);
    assert!(total_cost >= session.latest_state.total_cost, EInvalidParameter);
    assert!(readings_count > session.latest_state.readings_count, EInvalidParameter);

    // Validate cost matches usage at the agreed rate
    let expected_cost = calculate_cost(total_bytes, session.rate_per_mb);
    assert!(total_cost == expected_cost, EBalanceMismatch);

    // Ensure cost doesn't exceed consumer's budget
    assert!(total_cost <= session.tunnel.party_a_deposit(), EInsufficientBalance);

    let state_hash = compute_meter_hash_with_id(
        session.tunnel.id(),
        total_bytes,
        total_cost,
        readings_count,
        nonce,
    );

    session.latest_state = MeterState { total_bytes, total_cost, readings_count, nonce };

    // Both signatures must be provided together, or both empty
    assert!(
        (sig_a.is_empty() && sig_b.is_empty()) || (!sig_a.is_empty() && !sig_b.is_empty()),
        EInvalidSignature,
    );

    if (!sig_a.is_empty()) {
        session
            .tunnel
            .update_state(
                state_hash,
                nonce,
                party_a_balance,
                party_b_balance,
                timestamp,
                sig_a,
                sig_b,
                clock,
            );
    };
}

// ============================================
// SETTLEMENT
// ============================================

/// Calculate final settlement based on recorded usage.
public fun calculate_settlement<T>(session: &BandwidthSession<T>): (u64, u64) {
    let total = session.tunnel.total_balance();
    let provider_earned = session.latest_state.total_cost;
    assert!(provider_earned <= total, EInsufficientBalance);
    let consumer_refund = total - provider_earned;
    (consumer_refund, provider_earned)
}

/// Close the session cooperatively.
public fun close_session<T>(
    session: &mut BandwidthSession<T>,
    consumer_balance: u64,
    provider_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);

    session
        .tunnel
        .close_cooperative_and_transfer(
            consumer_balance,
            provider_balance,
            sig_a,
            sig_b,
            timestamp,
            clock,
            ctx,
        );

    session.status = SESSION_CLOSED;

    event::emit(BandwidthSessionSettled {
        total_bytes: session.latest_state.total_bytes,
        total_cost: session.latest_state.total_cost,
        readings_count: session.latest_state.readings_count,
        consumer_refund: consumer_balance,
        provider_earned: provider_balance,
    });
}

/// Raise a dispute.
public fun raise_dispute<T>(
    session: &mut BandwidthSession<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    other_party_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);
    session
        .tunnel
        .raise_dispute(
            state_hash,
            nonce,
            party_a_balance,
            party_b_balance,
            timestamp,
            other_party_sig,
            clock,
            ctx,
        );
    session.status = SESSION_DISPUTED;
}

/// Force close after dispute timeout.
public fun force_close<T>(session: &mut BandwidthSession<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(session.status == SESSION_DISPUTED, ENoActiveDispute);
    session
        .tunnel
        .force_close_after_timeout(
            clock,
            ctx,
        );
    session.status = SESSION_FORCE_CLOSED;
}

// ============================================
// ACCESSORS
// ============================================

public fun session_status<T>(s: &BandwidthSession<T>): u8 { s.status }

public fun session_total_bytes<T>(s: &BandwidthSession<T>): u64 { s.latest_state.total_bytes }

public fun session_total_cost<T>(s: &BandwidthSession<T>): u64 { s.latest_state.total_cost }

public fun session_readings_count<T>(s: &BandwidthSession<T>): u64 { s.latest_state.readings_count }

public fun session_rate_per_mb<T>(s: &BandwidthSession<T>): u64 { s.rate_per_mb }

public fun session_nonce<T>(s: &BandwidthSession<T>): u64 { s.latest_state.nonce }

public fun session_tunnel<T>(s: &BandwidthSession<T>): &Tunnel<T> { &s.tunnel }

public fun session_total_balance<T>(s: &BandwidthSession<T>): u64 {
    s.tunnel.total_balance()
}

public fun session_latest_state<T>(s: &BandwidthSession<T>): &MeterState {
    &s.latest_state
}

public fun meter_total_bytes(s: &MeterState): u64 { s.total_bytes }

public fun meter_total_cost(s: &MeterState): u64 { s.total_cost }

public fun meter_readings_count(s: &MeterState): u64 { s.readings_count }

public fun meter_nonce(s: &MeterState): u64 { s.nonce }

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_session_for_testing<T>(session: BandwidthSession<T>) {
    let BandwidthSession {
        id,
        tunnel,
        ..,
    } = session;
    id.delete();
    tunnel.destroy_for_testing();
}

#[test_only]
public fun set_status_for_testing<T>(session: &mut BandwidthSession<T>, status: u8) {
    session.status = status;
}

#[test_only]
public fun create_meter_state_for_testing(
    total_bytes: u64,
    total_cost: u64,
    readings_count: u64,
    nonce: u64,
): MeterState {
    MeterState { total_bytes, total_cost, readings_count, nonce }
}
