/// Example: API Credits (Cost Benefit)
///
/// Demonstrates how tunnels drastically reduce gas costs for high-frequency
/// micropayments. A client opens a tunnel with an API provider and deposits
/// credits upfront. Each API call is tracked off-chain as a signed state
/// update — no gas cost per call. Only 2 on-chain transactions are needed
/// regardless of how many API calls are made:
///
/// 1. Open session (deposit budget)
/// 2. Close session (settle actual usage)
///
/// **Without tunnels:** 1000 API calls = 1000 on-chain txs = 1000× gas fees
/// **With tunnels:**    1000 API calls = 2 on-chain txs = 2× gas fees
///
/// ## Flow:
/// ```
/// open_session() -> join_as_provider() -> [off-chain API calls] ->
///   record_usage() (optional checkpoint) -> close_session()
/// ```
module sui_tunnel::example_api_credits;

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

// ============================================
// STRUCTS
// ============================================

/// Off-chain API usage state that gets hashed and committed to the tunnel.
public struct ApiUsageState has copy, drop, store {
    /// Total number of API calls made
    total_calls: u64,
    /// Total cost accumulated (price_per_call * total_calls)
    total_cost: u64,
    /// State nonce (monotonically increasing)
    nonce: u64,
}

/// An API credit session wrapping a Tunnel.
/// The client (party A) deposits credits upfront.
/// The provider (party B) serves API calls off-chain.
/// Settlement pays the provider for actual usage and refunds the client.
public struct ApiCreditSession<phantom T> has key, store {
    id: UID,
    /// The underlying tunnel
    tunnel: Tunnel<T>,
    /// Session status
    status: u8,
    /// Latest known usage state
    latest_state: ApiUsageState,
    /// Cost per API call in base units
    price_per_call: u64,
    /// Maximum calls allowed (0 = unlimited)
    max_calls: u64,
}

// ============================================
// EVENTS
// ============================================

public struct ApiSessionOpened has copy, drop {
    client: address,
    provider: address,
    price_per_call: u64,
    budget: u64,
}

public struct ApiSessionSettled has copy, drop {
    total_calls: u64,
    total_cost: u64,
    client_refund: u64,
    provider_earned: u64,
}

// ============================================
// CONSTANT GETTERS
// ============================================

public fun session_active(): u8 { SESSION_ACTIVE }

public fun session_closed(): u8 { SESSION_CLOSED }

public fun session_disputed(): u8 { SESSION_DISPUTED }

public fun session_force_closed(): u8 { SESSION_FORCE_CLOSED }

public fun default_timeout_ms(): u64 { DEFAULT_TIMEOUT_MS }

// ============================================
// SESSION LIFECYCLE
// ============================================

/// Client opens an API credit session by depositing a budget.
/// The budget covers future API calls at the specified price per call.
///
/// **Cost benefit:** This is the first of only 2 on-chain transactions needed,
/// regardless of how many API calls will be made.
public fun open_session<T>(
    client_address: address,
    client_pk: vector<u8>,
    provider_address: address,
    provider_pk: vector<u8>,
    budget: Coin<T>,
    price_per_call: u64,
    max_calls: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ApiCreditSession<T> {
    assert!(price_per_call > 0, EInvalidParameter);

    let budget_amount = budget.value();

    let mut tun = tunnel::create<T>(
        client_address,
        client_pk,
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

    event::emit(ApiSessionOpened {
        client: client_address,
        provider: provider_address,
        price_per_call,
        budget: budget_amount,
    });

    ApiCreditSession {
        id: object::new(ctx),
        tunnel: tun,
        status: SESSION_ACTIVE,
        latest_state: ApiUsageState { total_calls: 0, total_cost: 0, nonce: 0 },
        price_per_call,
        max_calls,
    }
}

/// Provider joins the session with optional collateral.
public fun join_as_provider<T>(
    session: &mut ApiCreditSession<T>,
    collateral: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);
    session.tunnel.deposit_party_b(collateral, clock, ctx);
}

// ============================================
// USAGE TRACKING
// ============================================

/// Compute the state hash for off-chain signing.
/// Both parties sign this hash after each API call (or batch of calls).
public fun compute_usage_hash<T>(
    session: &ApiCreditSession<T>,
    total_calls: u64,
    total_cost: u64,
    nonce: u64,
): vector<u8> {
    compute_usage_hash_with_id(session.tunnel.id(), total_calls, total_cost, nonce)
}

/// Compute usage hash from tunnel ID (avoids double-borrow).
public fun compute_usage_hash_with_id(
    tunnel_id: ID,
    total_calls: u64,
    total_cost: u64,
    nonce: u64,
): vector<u8> {
    let mut data = b"api_credits::usage";
    data.append(tunnel_id.to_bytes());
    data.append(signature::u64_to_be_bytes(total_calls));
    data.append(signature::u64_to_be_bytes(total_cost));
    data.append(signature::u64_to_be_bytes(nonce));
    hash::blake2b256(&data)
}

/// Record API usage on-chain (optional checkpoint).
/// Most usage tracking happens off-chain — this is only needed to
/// periodically anchor state on-chain for extra safety.
///
/// **Cost benefit:** This call is optional. Even without checkpoints,
/// the session can close with just the final state.
public fun record_usage<T>(
    session: &mut ApiCreditSession<T>,
    total_calls: u64,
    total_cost: u64,
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
    assert!(total_calls >= session.latest_state.total_calls, EInvalidParameter);
    assert!(total_cost >= session.latest_state.total_cost, EInvalidParameter);

    // Validate cost consistency
    // Guard against overflow in total_calls * price_per_call
    if (session.price_per_call > 0) {
        let max_calls = std::u64::max_value!() / session.price_per_call;
        assert!(total_calls <= max_calls, EOverflow);
    };
    let expected_cost = total_calls * session.price_per_call;
    assert!(total_cost == expected_cost, EBalanceMismatch);

    // Enforce max calls if set
    if (session.max_calls > 0) {
        assert!(total_calls <= session.max_calls, EOverflow);
    };

    // Ensure cost doesn't exceed client's budget
    assert!(total_cost <= session.tunnel.party_a_deposit(), EInsufficientBalance);

    let state_hash = compute_usage_hash_with_id(
        session.tunnel.id(),
        total_calls,
        total_cost,
        nonce,
    );

    session.latest_state = ApiUsageState { total_calls, total_cost, nonce };

    // Both signatures must be provided together, or both empty
    assert!(
        (sig_a.is_empty() && sig_b.is_empty()) || (!sig_a.is_empty() && !sig_b.is_empty()),
        EInvalidSignature,
    );

    // Sync state to the underlying tunnel when dual signatures are provided
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

/// Calculate the final settlement amounts based on recorded usage.
/// Client gets back unused budget; provider gets payment for calls served.
public fun calculate_settlement<T>(session: &ApiCreditSession<T>): (u64, u64) {
    let total = session.tunnel.total_balance();
    let provider_earned = session.latest_state.total_cost;
    assert!(provider_earned <= total, EInsufficientBalance);
    let client_refund = total - provider_earned;
    (client_refund, provider_earned)
}

/// Close the session cooperatively — the second of only 2 on-chain txs.
/// Both parties sign the final balance split based on actual API usage.
public fun close_session<T>(
    session: &mut ApiCreditSession<T>,
    client_balance: u64,
    provider_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);

    // Ensure cooperative close balances match the calculated settlement
    let (expected_client_refund, expected_provider_earned) = calculate_settlement(session);
    assert!(client_balance == expected_client_refund, EBalanceMismatch);
    assert!(provider_balance == expected_provider_earned, EBalanceMismatch);

    session
        .tunnel
        .close_cooperative_and_transfer(
            client_balance,
            provider_balance,
            sig_a,
            sig_b,
            timestamp,
            clock,
            ctx,
        );

    session.status = SESSION_CLOSED;

    event::emit(ApiSessionSettled {
        total_calls: session.latest_state.total_calls,
        total_cost: session.latest_state.total_cost,
        client_refund: client_balance,
        provider_earned: provider_balance,
    });
}

/// Raise a dispute if the provider claims more usage than actually occurred.
public fun raise_dispute<T>(
    session: &mut ApiCreditSession<T>,
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
public fun force_close<T>(session: &mut ApiCreditSession<T>, clock: &Clock, ctx: &mut TxContext) {
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

public fun session_status<T>(s: &ApiCreditSession<T>): u8 { s.status }

public fun session_total_calls<T>(s: &ApiCreditSession<T>): u64 { s.latest_state.total_calls }

public fun session_total_cost<T>(s: &ApiCreditSession<T>): u64 { s.latest_state.total_cost }

public fun session_price_per_call<T>(s: &ApiCreditSession<T>): u64 { s.price_per_call }

public fun session_max_calls<T>(s: &ApiCreditSession<T>): u64 { s.max_calls }

public fun session_nonce<T>(s: &ApiCreditSession<T>): u64 { s.latest_state.nonce }

public fun session_tunnel<T>(s: &ApiCreditSession<T>): &Tunnel<T> { &s.tunnel }

public fun session_total_balance<T>(s: &ApiCreditSession<T>): u64 {
    s.tunnel.total_balance()
}

public fun session_latest_state<T>(s: &ApiCreditSession<T>): &ApiUsageState {
    &s.latest_state
}

public fun usage_total_calls(state: &ApiUsageState): u64 { state.total_calls }

public fun usage_total_cost(state: &ApiUsageState): u64 { state.total_cost }

public fun usage_nonce(state: &ApiUsageState): u64 { state.nonce }

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_session_for_testing<T>(session: ApiCreditSession<T>) {
    let ApiCreditSession {
        id,
        tunnel,
        ..,
    } = session;
    id.delete();
    tunnel.destroy_for_testing();
}

#[test_only]
public fun set_status_for_testing<T>(session: &mut ApiCreditSession<T>, status: u8) {
    session.status = status;
}

#[test_only]
public fun create_usage_state_for_testing(
    total_calls: u64,
    total_cost: u64,
    nonce: u64,
): ApiUsageState {
    ApiUsageState { total_calls, total_cost, nonce }
}
