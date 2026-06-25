/// Example: Agent Micropayments
///
/// Autonomous agent-to-agent (machine-to-machine) micropayments: a consumer
/// agent streams pay-per-request to a provider agent over a real two-party
/// tunnel, with no human in the loop and no per-request gas. The consumer locks
/// a budget upfront, each request is tracked off-chain as a signed state update,
/// and the channel settles cooperatively for actual usage.
///
/// ## Flow:
/// ```
/// open_channel() -> join_as_provider() -> [off-chain requests] ->
///   record_usage() (optional checkpoint) -> top_up_budget() (optional) ->
///   close_channel()
/// ```
///
/// ## Key Features:
/// - Pay-per-request billing settled in 2 on-chain txs regardless of volume.
/// - `should_settle` lets an autonomous consumer poll for the auto-settle point.
/// - `top_up_budget` extends a long-running agent's budget without reopening.
module sui_tunnel::example_agent_micropayments;

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
const EMaxRequestsExceeded: vector<u8> = b"The maximum number of requests has been exceeded.";

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
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

// ============================================
// CONSTANTS
// ============================================

const CHANNEL_ACTIVE: u8 = 0;
const CHANNEL_CLOSED: u8 = 1;
const CHANNEL_DISPUTED: u8 = 2;
const CHANNEL_FORCE_CLOSED: u8 = 3;

const DEFAULT_TIMEOUT_MS: u64 = 3600000; // 1 hour

// ============================================
// STRUCTS
// ============================================

/// Off-chain request usage state that gets hashed and committed to the tunnel.
public struct RequestUsageState has copy, drop, store {
    /// Total number of requests served
    total_requests: u64,
    /// Total cost accumulated (price_per_request * total_requests)
    total_cost: u64,
    /// State nonce (monotonically increasing)
    nonce: u64,
}

/// An agent micropayment channel wrapping a Tunnel.
/// The consumer agent (party A) deposits a budget upfront.
/// The provider agent (party B) serves requests off-chain.
/// Settlement pays the provider for actual usage and refunds the consumer.
public struct AgentChannel<phantom T> has key, store {
    id: UID,
    /// The underlying tunnel
    tunnel: Tunnel<T>,
    /// Channel status
    status: u8,
    /// Latest known usage state
    latest_state: RequestUsageState,
    /// Cost per request in base units
    price_per_request: u64,
    /// Maximum requests allowed (0 = unlimited)
    max_requests: u64,
    /// Accumulated cost at which an autonomous consumer should trigger settlement
    settle_threshold: u64,
}

// ============================================
// EVENTS
// ============================================

public struct AgentChannelOpened has copy, drop {
    consumer_agent: address,
    provider_agent: address,
    price_per_request: u64,
    budget: u64,
}

public struct AgentChannelSettled has copy, drop {
    total_requests: u64,
    total_cost: u64,
    consumer_refund: u64,
    provider_earned: u64,
}

public struct BudgetToppedUp has copy, drop {
    consumer_agent: address,
    additional: u64,
    new_budget: u64,
}

// ============================================
// CONSTANT GETTERS
// ============================================

public fun channel_active(): u8 { CHANNEL_ACTIVE }

public fun channel_closed(): u8 { CHANNEL_CLOSED }

public fun channel_disputed(): u8 { CHANNEL_DISPUTED }

public fun channel_force_closed(): u8 { CHANNEL_FORCE_CLOSED }

public fun default_timeout_ms(): u64 { DEFAULT_TIMEOUT_MS }

// ============================================
// CHANNEL LIFECYCLE
// ============================================

/// Consumer agent opens a micropayment channel by depositing a budget.
/// The budget covers future requests at the specified price per request.
/// The caller (party A) funds their side; the provider joins separately.
/// Aborts (`EInvalidParameter`) if `price_per_request` is zero.
public fun open_channel<T>(
    consumer_address: address,
    consumer_pk: vector<u8>,
    provider_address: address,
    provider_pk: vector<u8>,
    budget: Coin<T>,
    price_per_request: u64,
    max_requests: u64,
    settle_threshold: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): AgentChannel<T> {
    assert!(price_per_request > 0, EInvalidParameter);

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

    event::emit(AgentChannelOpened {
        consumer_agent: consumer_address,
        provider_agent: provider_address,
        price_per_request,
        budget: budget_amount,
    });

    AgentChannel {
        id: object::new(ctx),
        tunnel: tun,
        status: CHANNEL_ACTIVE,
        latest_state: RequestUsageState { total_requests: 0, total_cost: 0, nonce: 0 },
        price_per_request,
        max_requests,
        settle_threshold,
    }
}

/// Provider agent joins the channel with optional collateral, activating the
/// tunnel. Aborts (`ENotAuthorized` in the tunnel) if the caller is not the
/// provider, and (`EInvalidState`) if the channel is not active.
public fun join_as_provider<T>(
    channel: &mut AgentChannel<T>,
    collateral: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(channel.status == CHANNEL_ACTIVE, EInvalidState);
    channel.tunnel.deposit_party_b(collateral, clock, ctx);
}

/// Consumer agent tops up the budget of a long-running channel by depositing
/// more party-A funds into the tunnel. Only the consumer agent (party A) may
/// call it (`ENotAuthorized`); the tunnel enforces that top-ups happen before
/// the provider joins. Aborts (`EInvalidState`) if the channel is not active.
public fun top_up_budget<T>(
    channel: &mut AgentChannel<T>,
    additional: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(channel.status == CHANNEL_ACTIVE, EInvalidState);
    assert!(ctx.sender() == channel.tunnel.party_a().party_address(), ENotAuthorized);

    let added = additional.value();
    channel.tunnel.deposit_party_a(additional, clock, ctx);

    event::emit(BudgetToppedUp {
        consumer_agent: ctx.sender(),
        additional: added,
        new_budget: channel.tunnel.total_balance(),
    });
}

/// Reclaim the full deposited budget if the provider never joins. Returns the
/// coin so the consumer can route it in a PTB. Reuses the tunnel's
/// pre-activation withdrawal, so only the consumer (the sole depositor) can
/// reclaim and only while the provider has not yet posted collateral. Aborts
/// (`EInvalidState`) if the channel is not active.
public fun cancel_channel<T>(
    channel: &mut AgentChannel<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(channel.status == CHANNEL_ACTIVE, EInvalidState);
    channel.status = CHANNEL_CLOSED;
    channel.tunnel.withdraw_before_active(clock, ctx)
}

// ============================================
// USAGE TRACKING
// ============================================

/// Compute the state hash for off-chain signing.
/// Both agents sign this hash after each request (or batch of requests).
public fun compute_usage_hash<T>(
    channel: &AgentChannel<T>,
    total_requests: u64,
    total_cost: u64,
    nonce: u64,
): vector<u8> {
    compute_usage_hash_with_id(channel.tunnel.id(), total_requests, total_cost, nonce)
}

/// Compute usage hash from tunnel ID (avoids double-borrow).
public fun compute_usage_hash_with_id(
    tunnel_id: ID,
    total_requests: u64,
    total_cost: u64,
    nonce: u64,
): vector<u8> {
    let mut data = b"agent_micropayments::usage";
    data.append(tunnel_id.to_bytes());
    data.append(signature::u64_to_be_bytes(total_requests));
    data.append(signature::u64_to_be_bytes(total_cost));
    data.append(signature::u64_to_be_bytes(nonce));
    hash::blake2b256(&data)
}

/// Record request usage on-chain (optional checkpoint).
/// Most usage tracking happens off-chain — this is only needed to periodically
/// anchor state on-chain for extra safety. Only a channel party may checkpoint
/// (`ENotAuthorized`), so a third party cannot poison the settlement-driving
/// `latest_state`. Signatures must be supplied as a dual pair or both empty;
/// only a dual pair syncs the tunnel state.
public fun record_usage<T>(
    channel: &mut AgentChannel<T>,
    total_requests: u64,
    total_cost: u64,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(channel.status == CHANNEL_ACTIVE, EInvalidState);
    let sender = ctx.sender();
    assert!(
        sender == channel.tunnel.party_a().party_address()
            || sender == channel.tunnel.party_b().party_address(),
        ENotAuthorized,
    );
    assert!(nonce > channel.latest_state.nonce, EInvalidNonce);
    assert!(total_requests >= channel.latest_state.total_requests, EStaleState);
    assert!(total_cost >= channel.latest_state.total_cost, EStaleState);

    // Guard against overflow in total_requests * price_per_request
    if (channel.price_per_request > 0) {
        let max_requests = std::u64::max_value!() / channel.price_per_request;
        assert!(total_requests <= max_requests, EOverflow);
    };
    let expected_cost = total_requests * channel.price_per_request;
    assert!(total_cost == expected_cost, EBalanceMismatch);

    // Enforce max requests if set
    if (channel.max_requests > 0) {
        assert!(total_requests <= channel.max_requests, EMaxRequestsExceeded);
    };

    // Ensure cost doesn't exceed consumer's budget
    assert!(total_cost <= channel.tunnel.party_a_deposit(), EInsufficientBalance);

    let state_hash = compute_usage_hash_with_id(
        channel.tunnel.id(),
        total_requests,
        total_cost,
        nonce,
    );

    channel.latest_state = RequestUsageState { total_requests, total_cost, nonce };

    // Both signatures must be provided together, or both empty
    assert!(
        (sig_a.is_empty() && sig_b.is_empty()) || (!sig_a.is_empty() && !sig_b.is_empty()),
        EInvalidSignature,
    );

    // Sync state to the underlying tunnel when dual signatures are provided
    if (!sig_a.is_empty()) {
        channel
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

/// True once the latest accumulated cost has reached a non-zero settle threshold.
/// An autonomous consumer polls this to know when to trigger settlement. A
/// threshold of 0 means no auto-settle watermark is set, so this always returns false.
public fun should_settle<T>(channel: &AgentChannel<T>): bool {
    channel.settle_threshold > 0 && channel.latest_state.total_cost >= channel.settle_threshold
}

/// Calculate the final settlement amounts based on recorded usage.
/// Consumer gets back its unspent budget; provider gets its own collateral back
/// plus payment for requests served. The split conserves the full tunnel balance.
public fun calculate_settlement<T>(channel: &AgentChannel<T>): (u64, u64) {
    let consumer_budget = channel.tunnel.party_a_deposit();
    let provider_collateral = channel.tunnel.party_b_deposit();
    let total_cost = channel.latest_state.total_cost;
    assert!(total_cost <= consumer_budget, EInsufficientBalance);
    let consumer_refund = consumer_budget - total_cost;
    let provider_earned = provider_collateral + total_cost;
    (consumer_refund, provider_earned)
}

/// Close the channel cooperatively — the second of only 2 on-chain txs.
/// Both agents sign the final balance split based on actual request usage.
/// Aborts (`EBalanceMismatch`) if the supplied split disagrees with the
/// calculated settlement.
public fun close_channel<T>(
    channel: &mut AgentChannel<T>,
    consumer_balance: u64,
    provider_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(channel.status == CHANNEL_ACTIVE, EInvalidState);

    let (expected_consumer_refund, expected_provider_earned) = calculate_settlement(channel);
    assert!(consumer_balance == expected_consumer_refund, EBalanceMismatch);
    assert!(provider_balance == expected_provider_earned, EBalanceMismatch);

    channel
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

    channel.status = CHANNEL_CLOSED;

    event::emit(AgentChannelSettled {
        total_requests: channel.latest_state.total_requests,
        total_cost: channel.latest_state.total_cost,
        consumer_refund: consumer_balance,
        provider_earned: provider_balance,
    });
}

/// Raise a dispute if the provider claims more usage than actually occurred.
public fun raise_dispute<T>(
    channel: &mut AgentChannel<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    other_party_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(channel.status == CHANNEL_ACTIVE, EInvalidState);
    channel
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
    channel.status = CHANNEL_DISPUTED;
}

/// Force close after dispute timeout. Aborts (`ENoActiveDispute`) if the
/// channel is not currently disputed.
public fun force_close<T>(channel: &mut AgentChannel<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(channel.status == CHANNEL_DISPUTED, ENoActiveDispute);
    channel
        .tunnel
        .force_close_after_timeout(
            clock,
            ctx,
        );
    channel.status = CHANNEL_FORCE_CLOSED;
}

// ============================================
// ACCESSORS
// ============================================

public fun channel_status<T>(c: &AgentChannel<T>): u8 { c.status }

public fun channel_total_requests<T>(c: &AgentChannel<T>): u64 { c.latest_state.total_requests }

public fun channel_total_cost<T>(c: &AgentChannel<T>): u64 { c.latest_state.total_cost }

public fun channel_price_per_request<T>(c: &AgentChannel<T>): u64 { c.price_per_request }

public fun channel_max_requests<T>(c: &AgentChannel<T>): u64 { c.max_requests }

public fun channel_settle_threshold<T>(c: &AgentChannel<T>): u64 { c.settle_threshold }

public fun channel_nonce<T>(c: &AgentChannel<T>): u64 { c.latest_state.nonce }

public fun channel_tunnel<T>(c: &AgentChannel<T>): &Tunnel<T> { &c.tunnel }

public fun channel_total_balance<T>(c: &AgentChannel<T>): u64 {
    c.tunnel.total_balance()
}

public fun channel_latest_state<T>(c: &AgentChannel<T>): &RequestUsageState {
    &c.latest_state
}

public fun usage_total_requests(state: &RequestUsageState): u64 { state.total_requests }

public fun usage_total_cost(state: &RequestUsageState): u64 { state.total_cost }

public fun usage_nonce(state: &RequestUsageState): u64 { state.nonce }

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_channel_for_testing<T>(channel: AgentChannel<T>) {
    let AgentChannel {
        id,
        tunnel,
        ..,
    } = channel;
    id.delete();
    tunnel.destroy_for_testing();
}

#[test_only]
public fun set_status_for_testing<T>(channel: &mut AgentChannel<T>, status: u8) {
    channel.status = status;
}

#[test_only]
public fun create_usage_state_for_testing(
    total_requests: u64,
    total_cost: u64,
    nonce: u64,
): RequestUsageState {
    RequestUsageState { total_requests, total_cost, nonce }
}

#[test_only]
public fun raise_dispute_current_state_for_testing<T>(
    channel: &mut AgentChannel<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(channel.status == CHANNEL_ACTIVE, EInvalidState);
    channel.tunnel.raise_dispute_current_state(clock, ctx);
    channel.status = CHANNEL_DISPUTED;
}

#[test_only]
public fun close_channel_no_sig_for_testing<T>(
    channel: &mut AgentChannel<T>,
    consumer_balance: u64,
    provider_balance: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(channel.status == CHANNEL_ACTIVE, EInvalidState);

    let (expected_consumer_refund, expected_provider_earned) = calculate_settlement(channel);
    assert!(consumer_balance == expected_consumer_refund, EBalanceMismatch);
    assert!(provider_balance == expected_provider_earned, EBalanceMismatch);

    channel
        .tunnel
        .close_cooperative_no_sig_for_testing(consumer_balance, provider_balance, clock, ctx);

    channel.status = CHANNEL_CLOSED;

    event::emit(AgentChannelSettled {
        total_requests: channel.latest_state.total_requests,
        total_cost: channel.latest_state.total_cost,
        consumer_refund: consumer_balance,
        provider_earned: provider_balance,
    });
}
