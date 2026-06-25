/// Example: Payment Channel
///
/// A simple bidirectional payment channel between two parties.
/// Demonstrates basic tunnel usage for off-chain payments.
///
/// ## Flow:
/// 1. Alice and Bob create a payment channel (tunnel)
/// 2. Both deposit funds
/// 3. They exchange payments off-chain by signing state updates
/// 4. Either party can close with the latest signed state
///
/// ## Key Features:
/// - Off-chain payments (no gas per payment)
/// - Instant finality between parties
/// - Dispute resolution if needed
module sui_tunnel::example_payment_channel;

use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::hash;
use sui_tunnel::signature;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EAlreadyExists: vector<u8> = b"The resource already exists and cannot be created again.";

#[error]
const EInvalidSignature: vector<u8> = b"Signature verification failed.";

#[error]
const EInvalidPublicKey: vector<u8> = b"The public key is invalid or has the wrong length for its scheme.";

#[error]
const ETunnelClosed: vector<u8> = b"The tunnel is closed or not in the required state for this operation.";

#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

#[error]
const EInvalidNonce: vector<u8> = b"The nonce is invalid; it must be strictly increasing.";

#[error]
const EDisputePeriodEnded: vector<u8> = b"The dispute period has already ended.";

#[error]
const ETimeoutNotReached: vector<u8> = b"The timeout has not been reached yet.";

#[error]
const EBalanceMismatch: vector<u8> = b"The balance does not match the expected amount after the operation.";

// ============================================
// CONSTANTS
// ============================================

/// Channel status: Open for payments
const CHANNEL_OPEN: u8 = 0;

/// Channel status: Closing (dispute period)
const CHANNEL_CLOSING: u8 = 1;

/// Channel status: Closed
const CHANNEL_CLOSED: u8 = 2;

/// Dispute period: 1 hour
const DISPUTE_PERIOD_MS: u64 = 3600000;

// ============================================
// STRUCTS
// ============================================

/// A bidirectional payment channel
public struct PaymentChannel<phantom T> has key, store {
    id: UID,
    /// Party A (channel initiator)
    party_a: address,
    /// Party B (channel responder)
    party_b: address,
    /// Party A's balance in channel
    balance_a: Balance<T>,
    /// Party B's balance in channel
    balance_b: Balance<T>,
    /// Current channel status
    status: u8,
    /// Latest agreed state nonce
    nonce: u64,
    /// Hash of latest state (balances at nonce)
    state_hash: vector<u8>,
    /// Closing initiated timestamp (for disputes)
    closing_started_at: u64,
    /// Proposed final balance for A (during closing)
    proposed_balance_a: u64,
    /// Proposed final balance for B (during closing)
    proposed_balance_b: u64,
    /// Party A's public key for signature verification
    pk_a: vector<u8>,
    /// Party B's public key for signature verification
    pk_b: vector<u8>,
}

/// Off-chain payment state (signed by both parties)
public struct PaymentState has copy, drop, store {
    /// Channel ID
    channel_id: vector<u8>,
    /// State nonce (must be increasing)
    nonce: u64,
    /// Balance for party A
    balance_a: u64,
    /// Balance for party B
    balance_b: u64,
}

/// A signed state update
public struct SignedState has copy, drop, store {
    /// The payment state
    state: PaymentState,
    /// Signature from party A
    sig_a: vector<u8>,
    /// Signature from party B
    sig_b: vector<u8>,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a channel is opened
public struct ChannelOpened has copy, drop {
    party_a: address,
    party_b: address,
    initial_balance: u64,
}

/// Emitted when a channel is funded by party B
public struct ChannelFunded has copy, drop {
    party_a: address,
    party_b: address,
    total_balance: u64,
}

/// Emitted when closing is initiated
public struct ChannelClosingInitiated has copy, drop {
    initiated_by: address,
    nonce: u64,
    proposed_balance_a: u64,
    proposed_balance_b: u64,
}

/// Emitted when channel is closed
public struct ChannelClosed has copy, drop {
    party_a: address,
    party_b: address,
    final_balance_a: u64,
    final_balance_b: u64,
}

/// Emitted when a party deposits into the channel
public struct ChannelDeposit has copy, drop {
    party: address,
    amount: u64,
}

/// Emitted when a close is challenged
public struct ChannelChallenged has copy, drop {
    challenger: address,
    new_nonce: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS
// ============================================

public fun channel_open(): u8 { CHANNEL_OPEN }

public fun channel_closing(): u8 { CHANNEL_CLOSING }

public fun channel_closed(): u8 { CHANNEL_CLOSED }

public fun dispute_period_ms(): u64 { DISPUTE_PERIOD_MS }

// ============================================
// CHANNEL LIFECYCLE
// ============================================

/// Creates a new payment channel
public fun create_channel<T>(
    party_b: address,
    initial_deposit: Coin<T>,
    pk_a: vector<u8>,
    ctx: &mut TxContext,
): PaymentChannel<T> {
    let party_a = ctx.sender();
    assert!(party_a != party_b, EInvalidParties);
    assert!(pk_a.length() > 0, EInvalidPublicKey);

    let balance = initial_deposit.into_balance();
    let initial_amount = balance.value();

    // Initial state: all funds belong to depositor
    let initial_state = create_state_bytes(
        &vector[], // Will be filled with actual ID
        0,
        initial_amount,
        0,
    );

    event::emit(ChannelOpened { party_a, party_b, initial_balance: initial_amount });

    PaymentChannel {
        id: object::new(ctx),
        party_a,
        party_b,
        balance_a: balance,
        balance_b: balance::zero(),
        status: CHANNEL_OPEN,
        nonce: 0,
        state_hash: hash::blake2b256(&initial_state),
        closing_started_at: 0,
        proposed_balance_a: initial_amount,
        proposed_balance_b: 0,
        pk_a,
        pk_b: vector[],
    }
}

/// Party B joins the channel with their deposit
public fun join_channel<T>(
    channel: &mut PaymentChannel<T>,
    deposit: Coin<T>,
    pk_b: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == channel.party_b, ENotAuthorized);
    assert!(channel.status == CHANNEL_OPEN, ETunnelClosed);
    assert!(channel.balance_b.value() == 0, EAlreadyExists);
    assert!(pk_b.length() > 0, EInvalidPublicKey);

    let deposit_balance = deposit.into_balance();
    channel.balance_b.join(deposit_balance);

    // Store party B's public key
    channel.pk_b = pk_b;

    // Update proposed balances
    channel.proposed_balance_b = channel.balance_b.value();

    event::emit(ChannelFunded {
        party_a: channel.party_a,
        party_b: channel.party_b,
        total_balance: channel.balance_a.value() + channel.balance_b.value(),
    });
}

/// Party A adds more funds to their side
public fun deposit_a<T>(channel: &mut PaymentChannel<T>, deposit: Coin<T>, ctx: &TxContext) {
    assert!(ctx.sender() == channel.party_a, ENotAuthorized);
    assert!(channel.status == CHANNEL_OPEN, ETunnelClosed);

    let deposit_balance = deposit.into_balance();
    let amount = deposit_balance.value();
    channel.balance_a.join(deposit_balance);

    event::emit(ChannelDeposit { party: channel.party_a, amount });
}

/// Party B adds more funds to their side
public fun deposit_b<T>(channel: &mut PaymentChannel<T>, deposit: Coin<T>, ctx: &TxContext) {
    assert!(ctx.sender() == channel.party_b, ENotAuthorized);
    assert!(channel.status == CHANNEL_OPEN, ETunnelClosed);

    let deposit_balance = deposit.into_balance();
    let amount = deposit_balance.value();
    channel.balance_b.join(deposit_balance);

    event::emit(ChannelDeposit { party: channel.party_b, amount });
}

// ============================================
// STATE UPDATES (OFF-CHAIN COORDINATION)
// ============================================

/// Creates state bytes for signing
public fun create_state_bytes(
    channel_id: &vector<u8>,
    nonce: u64,
    balance_a: u64,
    balance_b: u64,
): vector<u8> {
    let mut data = b"payment_channel::state";

    // Add channel ID
    data.append(*channel_id);

    // Add nonce
    data.append(signature::u64_to_be_bytes(nonce));

    // Add balances
    data.append(signature::u64_to_be_bytes(balance_a));

    data.append(signature::u64_to_be_bytes(balance_b));

    data
}

/// Creates a payment state struct
public fun create_payment_state(
    channel_id: vector<u8>,
    nonce: u64,
    balance_a: u64,
    balance_b: u64,
): PaymentState {
    PaymentState {
        channel_id,
        nonce,
        balance_a,
        balance_b,
    }
}

/// Wraps a state with signatures
public fun create_signed_state(
    state: PaymentState,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
): SignedState {
    SignedState {
        state,
        sig_a,
        sig_b,
    }
}

// ============================================
// CHANNEL CLOSING
// ============================================

/// Initiates closing with the latest signed state
/// Starts a dispute period where the other party can challenge
public fun initiate_close<T>(
    channel: &mut PaymentChannel<T>,
    nonce: u64,
    balance_a: u64,
    balance_b: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(sender == channel.party_a || sender == channel.party_b, ENotAuthorized);
    assert!(channel.status == CHANNEL_OPEN, ETunnelClosed);

    // Verify total balances match
    let total = channel.balance_a.value() + channel.balance_b.value();
    assert!(balance_a + balance_b == total, EBalanceMismatch);

    // Verify nonce strictly advances
    assert!(nonce > channel.nonce, EInvalidNonce);

    // Create state bytes for verification
    let channel_id = channel.id.uid_to_bytes();
    let state_bytes = create_state_bytes(&channel_id, nonce, balance_a, balance_b);

    // Verify signatures using stored public keys
    assert!(signature::verify_ed25519(&channel.pk_a, &state_bytes, &sig_a), EInvalidSignature);
    assert!(signature::verify_ed25519(&channel.pk_b, &state_bytes, &sig_b), EInvalidSignature);

    let now = clock.timestamp_ms();

    // Start closing
    channel.status = CHANNEL_CLOSING;
    channel.nonce = nonce;
    channel.state_hash = hash::blake2b256(&state_bytes);
    channel.closing_started_at = now;
    channel.proposed_balance_a = balance_a;
    channel.proposed_balance_b = balance_b;

    event::emit(ChannelClosingInitiated {
        initiated_by: sender,
        nonce,
        proposed_balance_a: balance_a,
        proposed_balance_b: balance_b,
    });
}

/// Challenge with a newer state during dispute period
public fun challenge_close<T>(
    channel: &mut PaymentChannel<T>,
    nonce: u64,
    balance_a: u64,
    balance_b: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(sender == channel.party_a || sender == channel.party_b, ENotAuthorized);
    assert!(channel.status == CHANNEL_CLOSING, EInvalidState);

    let now = clock.timestamp_ms();

    // Must be within dispute period
    assert!(now < channel.closing_started_at + DISPUTE_PERIOD_MS, EDisputePeriodEnded);

    // Must have higher nonce
    assert!(nonce > channel.nonce, EInvalidNonce);

    // Verify total balances match
    let total = channel.balance_a.value() + channel.balance_b.value();
    assert!(balance_a + balance_b == total, EBalanceMismatch);

    // Create state bytes for verification
    let channel_id = channel.id.uid_to_bytes();
    let state_bytes = create_state_bytes(&channel_id, nonce, balance_a, balance_b);

    // Verify signatures using stored public keys
    assert!(signature::verify_ed25519(&channel.pk_a, &state_bytes, &sig_a), EInvalidSignature);
    assert!(signature::verify_ed25519(&channel.pk_b, &state_bytes, &sig_b), EInvalidSignature);

    // Update to newer state
    channel.nonce = nonce;
    channel.state_hash = hash::blake2b256(&state_bytes);
    channel.proposed_balance_a = balance_a;
    channel.proposed_balance_b = balance_b;
    // Restart dispute period
    channel.closing_started_at = now;

    event::emit(ChannelChallenged { challenger: sender, new_nonce: nonce });
}

/// Finalize close after dispute period.
/// Transfers coins directly to the parties to prevent fund redirection in PTBs.
public fun finalize_close<T>(channel: &mut PaymentChannel<T>, clock: &Clock, ctx: &mut TxContext) {
    let sender = ctx.sender();
    assert!(sender == channel.party_a || sender == channel.party_b, ENotAuthorized);
    assert!(channel.status == CHANNEL_CLOSING, EInvalidState);

    let now = clock.timestamp_ms();

    // Dispute period must have passed
    assert!(now >= channel.closing_started_at + DISPUTE_PERIOD_MS, ETimeoutNotReached);

    channel.status = CHANNEL_CLOSED;

    event::emit(ChannelClosed {
        party_a: channel.party_a,
        party_b: channel.party_b,
        final_balance_a: channel.proposed_balance_a,
        final_balance_b: channel.proposed_balance_b,
    });

    let final_a = channel.proposed_balance_a;
    let final_b = channel.proposed_balance_b;
    payout(channel, final_a, final_b, ctx);
}

/// Cooperative close - both parties agree, no dispute period needed.
/// Transfers coins directly to the parties to prevent fund redirection in PTBs.
public fun cooperative_close<T>(
    channel: &mut PaymentChannel<T>,
    nonce: u64,
    balance_a: u64,
    balance_b: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(channel.status == CHANNEL_OPEN, ETunnelClosed);

    // Verify total balances match
    let total = channel.balance_a.value() + channel.balance_b.value();
    assert!(balance_a + balance_b == total, EBalanceMismatch);

    // The signed payment-state nonce must advance to prevent replaying a stale split
    assert!(nonce > channel.nonce, EInvalidNonce);

    // Create close message
    let channel_id = channel.id.uid_to_bytes();
    let close_msg = build_close_msg(&channel_id, nonce, balance_a, balance_b);

    // Verify signatures using stored public keys
    assert!(signature::verify_ed25519(&channel.pk_a, &close_msg, &sig_a), EInvalidSignature);
    assert!(signature::verify_ed25519(&channel.pk_b, &close_msg, &sig_b), EInvalidSignature);

    channel.nonce = nonce;
    channel.status = CHANNEL_CLOSED;

    event::emit(ChannelClosed {
        party_a: channel.party_a,
        party_b: channel.party_b,
        final_balance_a: balance_a,
        final_balance_b: balance_b,
    });

    payout(channel, balance_a, balance_b, ctx);
}

/// Builds the cooperative-close message bound to the payment-state nonce.
fun build_close_msg(
    channel_id: &vector<u8>,
    nonce: u64,
    balance_a: u64,
    balance_b: u64,
): vector<u8> {
    let mut close_msg = b"payment_channel::close";
    close_msg.append(*channel_id);
    close_msg.append(signature::u64_to_be_bytes(balance_a));
    close_msg.append(signature::u64_to_be_bytes(balance_b));
    close_msg.append(signature::u64_to_be_bytes(nonce));
    close_msg
}

/// Merges both per-party pools, then pays each party its agreed amount so any
/// net cross-party settlement is payable regardless of deposit direction.
fun payout<T>(
    channel: &mut PaymentChannel<T>,
    balance_a: u64,
    balance_b: u64,
    ctx: &mut TxContext,
) {
    let mut combined = channel.balance_a.withdraw_all();
    combined.join(channel.balance_b.withdraw_all());

    let coin_a = coin::from_balance(combined.split(balance_a), ctx);
    let coin_b = coin::from_balance(combined.split(balance_b), ctx);
    combined.destroy_zero();

    // Transfer directly to parties to prevent interception
    transfer::public_transfer(coin_a, channel.party_a);
    transfer::public_transfer(coin_b, channel.party_b);
}

// ============================================
// ACCESSORS
// ============================================

public fun channel_id<T>(channel: &PaymentChannel<T>): vector<u8> {
    channel.id.uid_to_bytes()
}

public fun channel_party_a<T>(channel: &PaymentChannel<T>): address { channel.party_a }

public fun channel_party_b<T>(channel: &PaymentChannel<T>): address { channel.party_b }

public fun channel_balance_a<T>(channel: &PaymentChannel<T>): u64 { channel.balance_a.value() }

public fun channel_balance_b<T>(channel: &PaymentChannel<T>): u64 { channel.balance_b.value() }

public fun channel_total_balance<T>(channel: &PaymentChannel<T>): u64 {
    channel.balance_a.value() + channel.balance_b.value()
}

public fun channel_status<T>(channel: &PaymentChannel<T>): u8 { channel.status }

public fun channel_nonce<T>(channel: &PaymentChannel<T>): u64 { channel.nonce }

public fun channel_state_hash<T>(channel: &PaymentChannel<T>): &vector<u8> { &channel.state_hash }

public fun channel_pk_a<T>(channel: &PaymentChannel<T>): &vector<u8> { &channel.pk_a }

public fun channel_pk_b<T>(channel: &PaymentChannel<T>): &vector<u8> { &channel.pk_b }

// PaymentState accessors
public fun state_channel_id(state: &PaymentState): &vector<u8> { &state.channel_id }

public fun state_nonce(state: &PaymentState): u64 { state.nonce }

public fun state_balance_a(state: &PaymentState): u64 { state.balance_a }

public fun state_balance_b(state: &PaymentState): u64 { state.balance_b }

// SignedState accessors
public fun signed_state(ss: &SignedState): &PaymentState { &ss.state }

public fun signed_sig_a(ss: &SignedState): &vector<u8> { &ss.sig_a }

public fun signed_sig_b(ss: &SignedState): &vector<u8> { &ss.sig_b }

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun create_funded_for_testing<T>(
    party_a: address,
    party_b: address,
    deposit_a: Coin<T>,
    deposit_b: Coin<T>,
    ctx: &mut TxContext,
): PaymentChannel<T> {
    let balance_a = deposit_a.into_balance();
    let balance_b = deposit_b.into_balance();
    let total = balance_a.value() + balance_b.value();
    PaymentChannel {
        id: object::new(ctx),
        party_a,
        party_b,
        balance_a,
        balance_b,
        status: CHANNEL_OPEN,
        nonce: 0,
        state_hash: vector[],
        closing_started_at: 0,
        proposed_balance_a: total,
        proposed_balance_b: 0,
        pk_a: x"1111111111111111111111111111111111111111111111111111111111111111",
        pk_b: x"2222222222222222222222222222222222222222222222222222222222222222",
    }
}

#[test_only]
public fun destroy_for_testing<T>(channel: PaymentChannel<T>) {
    let PaymentChannel { id, balance_a, balance_b, .. } = channel;
    id.delete();
    balance_a.destroy_for_testing();
    balance_b.destroy_for_testing();
}

/// Cooperative close skipping only the signature check; the nonce and
/// balance-sum guards still apply so replay and split behavior stay testable.
#[test_only]
public fun cooperative_close_no_sig_for_testing<T>(
    channel: &mut PaymentChannel<T>,
    nonce: u64,
    balance_a: u64,
    balance_b: u64,
    ctx: &mut TxContext,
) {
    assert!(channel.status == CHANNEL_OPEN, ETunnelClosed);
    let total = channel.balance_a.value() + channel.balance_b.value();
    assert!(balance_a + balance_b == total, EBalanceMismatch);
    assert!(nonce > channel.nonce, EInvalidNonce);

    channel.nonce = nonce;
    channel.status = CHANNEL_CLOSED;

    event::emit(ChannelClosed {
        party_a: channel.party_a,
        party_b: channel.party_b,
        final_balance_a: balance_a,
        final_balance_b: balance_b,
    });

    payout(channel, balance_a, balance_b, ctx);
}

#[test_only]
public fun set_closing_for_testing<T>(
    channel: &mut PaymentChannel<T>,
    nonce: u64,
    balance_a: u64,
    balance_b: u64,
    closing_started_at: u64,
) {
    channel.status = CHANNEL_CLOSING;
    channel.nonce = nonce;
    channel.proposed_balance_a = balance_a;
    channel.proposed_balance_b = balance_b;
    channel.closing_started_at = closing_started_at;
}

#[test_only]
public fun set_status_open_for_testing<T>(channel: &mut PaymentChannel<T>) {
    channel.status = CHANNEL_OPEN;
}
