/// Example: Token Billing (Dual-Rate Metering)
///
/// Demonstrates pay-per-token LLM billing over a two-party tunnel. A client
/// opens a tunnel with an inference provider and deposits a budget upfront.
/// Each request is metered off-chain as a signed state update at separate
/// prompt and completion token rates — no gas cost per request. Only 2
/// on-chain transactions are needed regardless of how many requests are made:
///
/// 1. Open session (deposit budget)
/// 2. Close session (settle actual usage)
///
/// **Without tunnels:** 1000 requests = 1000 on-chain txs = 1000× gas fees
/// **With tunnels:**    1000 requests = 2 on-chain txs = 2× gas fees
///
/// ## Flow:
/// ```
/// open_session() -> join_as_provider() -> [off-chain inference requests] ->
///   record_usage() (optional checkpoint) -> close_session()
/// ```
///
/// ## Key Features:
/// - Dual-rate metering: prompt and completion tokens are priced separately.
/// - Monotonic usage and budget caps enforced on every checkpoint.
module sui_tunnel::example_token_billing;

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
const EStaleState: vector<u8> = b"The state update was rejected because a newer state already exists.";

#[error]
const ENoActiveDispute: vector<u8> = b"There is no active dispute to act on.";

#[error]
const EInsufficientBalance: vector<u8> = b"Insufficient balance for this operation.";

#[error]
const EBalanceMismatch: vector<u8> = b"The balance does not match the expected amount after the operation.";

#[error]
const ETokenLimitExceeded: vector<u8> = b"The total tokens exceed the session token cap.";

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

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

/// Off-chain token usage state that gets hashed and committed to the tunnel.
public struct TokenUsageState has copy, drop, store {
    /// Total prompt tokens billed
    prompt_tokens: u64,
    /// Total completion tokens billed
    completion_tokens: u64,
    /// Total cost accumulated (prompt_tokens * prompt_price + completion_tokens * completion_price)
    total_cost: u64,
    /// State nonce (monotonically increasing)
    nonce: u64,
}

/// A token billing session wrapping a Tunnel.
/// The client (party A) deposits a budget upfront.
/// The provider (party B) serves inference requests off-chain.
/// Settlement pays the provider for actual usage and refunds the client.
public struct TokenBillingSession<phantom T> has key, store {
    id: UID,
    /// The underlying tunnel
    tunnel: Tunnel<T>,
    /// Session status
    status: u8,
    /// Latest known usage state
    latest_state: TokenUsageState,
    /// Cost per prompt token in base units
    prompt_price: u64,
    /// Cost per completion token in base units
    completion_price: u64,
    /// Maximum total tokens allowed (0 = unlimited)
    max_tokens: u64,
}

// ============================================
// EVENTS
// ============================================

public struct BillingSessionOpened has copy, drop {
    client: address,
    provider: address,
    prompt_price: u64,
    completion_price: u64,
    budget: u64,
}

public struct BillingSessionSettled has copy, drop {
    prompt_tokens: u64,
    completion_tokens: u64,
    total_cost: u64,
    client_refund: u64,
    provider_earned: u64,
}

// ============================================
// CONSTANT GETTERS
// ============================================

/// Status of a session accepting off-chain usage updates.
public fun session_active(): u8 { SESSION_ACTIVE }

/// Status of a session settled cooperatively.
public fun session_closed(): u8 { SESSION_CLOSED }

/// Status of a session with an open dispute.
public fun session_disputed(): u8 { SESSION_DISPUTED }

/// Status of a session settled by dispute timeout.
public fun session_force_closed(): u8 { SESSION_FORCE_CLOSED }

/// Dispute/timeout window applied to new sessions, in milliseconds.
public fun default_timeout_ms(): u64 { DEFAULT_TIMEOUT_MS }

// ============================================
// SESSION LIFECYCLE
// ============================================

/// Client opens a token billing session by depositing a budget.
/// The budget covers future requests at the specified prompt and completion rates.
///
/// **Cost benefit:** This is the first of only 2 on-chain transactions needed,
/// regardless of how many requests will be made.
public fun open_session<T>(
    client_address: address,
    client_pk: vector<u8>,
    provider_address: address,
    provider_pk: vector<u8>,
    budget: Coin<T>,
    prompt_price: u64,
    completion_price: u64,
    max_tokens: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): TokenBillingSession<T> {
    assert!(prompt_price > 0, EInvalidParameter);
    assert!(completion_price > 0, EInvalidParameter);

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

    event::emit(BillingSessionOpened {
        client: client_address,
        provider: provider_address,
        prompt_price,
        completion_price,
        budget: budget_amount,
    });

    TokenBillingSession {
        id: object::new(ctx),
        tunnel: tun,
        status: SESSION_ACTIVE,
        latest_state: TokenUsageState {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_cost: 0,
            nonce: 0,
        },
        prompt_price,
        completion_price,
        max_tokens,
    }
}

/// Provider joins the session with optional collateral.
public fun join_as_provider<T>(
    session: &mut TokenBillingSession<T>,
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
/// Both parties sign this hash after each request (or batch of requests).
public fun compute_usage_hash<T>(
    session: &TokenBillingSession<T>,
    prompt_tokens: u64,
    completion_tokens: u64,
    total_cost: u64,
    nonce: u64,
): vector<u8> {
    compute_usage_hash_with_id(
        session.tunnel.id(),
        prompt_tokens,
        completion_tokens,
        total_cost,
        nonce,
    )
}

/// Compute usage hash from tunnel ID (avoids double-borrow).
public fun compute_usage_hash_with_id(
    tunnel_id: ID,
    prompt_tokens: u64,
    completion_tokens: u64,
    total_cost: u64,
    nonce: u64,
): vector<u8> {
    let mut data = b"token_billing::usage";
    data.append(tunnel_id.to_bytes());
    data.append(signature::u64_to_be_bytes(prompt_tokens));
    data.append(signature::u64_to_be_bytes(completion_tokens));
    data.append(signature::u64_to_be_bytes(total_cost));
    data.append(signature::u64_to_be_bytes(nonce));
    hash::blake2b256(&data)
}

/// Record token usage on-chain (optional checkpoint).
/// Most usage tracking happens off-chain — this is only needed to
/// periodically anchor state on-chain for extra safety.
///
/// **Cost benefit:** This call is optional. Even without checkpoints,
/// the session can close with just the final state.
public fun record_usage<T>(
    session: &mut TokenBillingSession<T>,
    prompt_tokens: u64,
    completion_tokens: u64,
    total_cost: u64,
    nonce: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);
    let sender = ctx.sender();
    assert!(
        sender == session.tunnel.party_a().party_address() ||
        sender == session.tunnel.party_b().party_address(),
        ENotAuthorized,
    );
    assert!(nonce > session.latest_state.nonce, EInvalidNonce);
    assert!(prompt_tokens >= session.latest_state.prompt_tokens, EStaleState);
    assert!(completion_tokens >= session.latest_state.completion_tokens, EStaleState);
    assert!(total_cost >= session.latest_state.total_cost, EStaleState);

    // Validate cost consistency.
    // Guard against overflow in each rate product and their sum.
    let max_prompt = std::u64::max_value!() / session.prompt_price;
    assert!(prompt_tokens <= max_prompt, EOverflow);
    let prompt_cost = prompt_tokens * session.prompt_price;

    let max_completion = std::u64::max_value!() / session.completion_price;
    assert!(completion_tokens <= max_completion, EOverflow);
    let completion_cost = completion_tokens * session.completion_price;

    assert!(prompt_cost <= std::u64::max_value!() - completion_cost, EOverflow);
    let expected_cost = prompt_cost + completion_cost;
    assert!(total_cost == expected_cost, EBalanceMismatch);

    // Enforce total token cap if set.
    if (session.max_tokens > 0) {
        assert!(prompt_tokens <= std::u64::max_value!() - completion_tokens, EOverflow);
        assert!(prompt_tokens + completion_tokens <= session.max_tokens, ETokenLimitExceeded);
    };

    // Ensure cost doesn't exceed client's budget.
    assert!(total_cost <= session.tunnel.party_a_deposit(), EInsufficientBalance);

    // Both signatures must be provided together, or both empty.
    assert!(
        (sig_a.is_empty() && sig_b.is_empty()) || (!sig_a.is_empty() && !sig_b.is_empty()),
        EInvalidSignature,
    );

    let state_hash = compute_usage_hash_with_id(
        session.tunnel.id(),
        prompt_tokens,
        completion_tokens,
        total_cost,
        nonce,
    );

    session.latest_state = TokenUsageState { prompt_tokens, completion_tokens, total_cost, nonce };

    // Sync state to the underlying tunnel when dual signatures are provided.
    // The committed split is derived from the metered cost so a later dispute
    // cannot settle on balances that diverge from usage: the provider earns its
    // collateral back plus the metered cost, the client keeps the unspent budget.
    if (!sig_a.is_empty()) {
        let provider_earned = session.tunnel.party_b_deposit() + total_cost;
        let client_refund = session.tunnel.party_a_deposit() - total_cost;
        session
            .tunnel
            .update_state(
                state_hash,
                nonce,
                client_refund,
                provider_earned,
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
/// Client gets back its unused budget; provider gets its own collateral back
/// plus payment for tokens served, so each side recovers its own deposit and
/// the split conserves the full tunnel balance.
public fun calculate_settlement<T>(session: &TokenBillingSession<T>): (u64, u64) {
    let client_budget = session.tunnel.party_a_deposit();
    let total_cost = session.latest_state.total_cost;
    assert!(total_cost <= client_budget, EInsufficientBalance);
    let provider_earned = session.tunnel.party_b_deposit() + total_cost;
    let client_refund = client_budget - total_cost;
    (client_refund, provider_earned)
}

/// Close the session cooperatively — the second of only 2 on-chain txs.
/// Both parties sign the final balance split based on actual token usage.
public fun close_session<T>(
    session: &mut TokenBillingSession<T>,
    client_balance: u64,
    provider_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);

    // Ensure cooperative close balances match the calculated settlement.
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

    event::emit(BillingSessionSettled {
        prompt_tokens: session.latest_state.prompt_tokens,
        completion_tokens: session.latest_state.completion_tokens,
        total_cost: session.latest_state.total_cost,
        client_refund: client_balance,
        provider_earned: provider_balance,
    });
}

/// Raise a dispute if the provider claims more usage than actually occurred.
public fun raise_dispute<T>(
    session: &mut TokenBillingSession<T>,
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

/// Reclaims the client's escrowed budget before the provider joins. Returns the
/// coin so the client can route it in a PTB. Reuses the tunnel's pre-activation
/// withdrawal, so only the client (the sole depositor) can reclaim while the
/// provider has posted nothing. Aborts `EInvalidState` if the session is not active.
public fun cancel_session<T>(
    session: &mut TokenBillingSession<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);
    session.status = SESSION_CLOSED;
    session.tunnel.withdraw_before_active(clock, ctx)
}

/// Force close after dispute timeout.
public fun force_close<T>(
    session: &mut TokenBillingSession<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
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

/// Current lifecycle status of the session.
public fun session_status<T>(s: &TokenBillingSession<T>): u8 { s.status }

/// Total prompt tokens billed in the latest committed state.
public fun session_total_prompt_tokens<T>(s: &TokenBillingSession<T>): u64 {
    s.latest_state.prompt_tokens
}

/// Total completion tokens billed in the latest committed state.
public fun session_total_completion_tokens<T>(s: &TokenBillingSession<T>): u64 {
    s.latest_state.completion_tokens
}

/// Accumulated cost in the latest committed state.
public fun session_total_cost<T>(s: &TokenBillingSession<T>): u64 { s.latest_state.total_cost }

/// Price charged per prompt token, in base units.
public fun session_prompt_price<T>(s: &TokenBillingSession<T>): u64 { s.prompt_price }

/// Price charged per completion token, in base units.
public fun session_completion_price<T>(s: &TokenBillingSession<T>): u64 { s.completion_price }

/// Maximum total tokens allowed, or 0 for unlimited.
public fun session_max_tokens<T>(s: &TokenBillingSession<T>): u64 { s.max_tokens }

/// Nonce of the latest committed state.
public fun session_nonce<T>(s: &TokenBillingSession<T>): u64 { s.latest_state.nonce }

/// The underlying tunnel backing this session.
public fun session_tunnel<T>(s: &TokenBillingSession<T>): &Tunnel<T> { &s.tunnel }

/// Combined deposits currently locked in the tunnel.
public fun session_total_balance<T>(s: &TokenBillingSession<T>): u64 {
    s.tunnel.total_balance()
}

/// The latest committed off-chain usage state.
public fun session_latest_state<T>(s: &TokenBillingSession<T>): &TokenUsageState {
    &s.latest_state
}

/// Prompt tokens recorded in this usage state.
public fun usage_prompt_tokens(state: &TokenUsageState): u64 { state.prompt_tokens }

/// Completion tokens recorded in this usage state.
public fun usage_completion_tokens(state: &TokenUsageState): u64 { state.completion_tokens }

/// Accumulated cost recorded in this usage state.
public fun usage_total_cost(state: &TokenUsageState): u64 { state.total_cost }

/// Nonce of this usage state.
public fun usage_nonce(state: &TokenUsageState): u64 { state.nonce }

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_session_for_testing<T>(session: TokenBillingSession<T>) {
    let TokenBillingSession {
        id,
        tunnel,
        ..,
    } = session;
    id.delete();
    tunnel.destroy_for_testing();
}

#[test_only]
public fun set_status_for_testing<T>(session: &mut TokenBillingSession<T>, status: u8) {
    session.status = status;
}

#[test_only]
public fun create_usage_state_for_testing(
    prompt_tokens: u64,
    completion_tokens: u64,
    total_cost: u64,
    nonce: u64,
): TokenUsageState {
    TokenUsageState { prompt_tokens, completion_tokens, total_cost, nonce }
}
