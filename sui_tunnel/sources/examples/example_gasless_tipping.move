/// Example: Gasless Tipping
///
/// A one-directional micro-tipping channel: a tipper pre-funds a pot toward one
/// creator and sends many sub-cent tips off-chain as a signed running total.
/// Settlement happens once on-chain and is submittable by the creator or any
/// relayer, because it is gated on the tipper's signature rather than a sender
/// check, so the tipper pays no gas per tip and not even for settlement. The
/// tipper themselves cannot settle: doing so would let them pick an old, low
/// running total and underpay the creator.
///
/// Trust assumption: settlement relies on the submitting relayer choosing the
/// latest signed total. A relayer colluding with the tipper could submit a
/// stale, lower total, so a creator who wants a guarantee should run their own
/// relayer or settle the channel themselves.
///
/// ## Flow:
/// 1. Tipper opens a channel and deposits a pot toward one creator
/// 2. Tipper signs a running total off-chain after each tip (no gas)
/// 3. The creator or a relayer submits the latest signed total to settle once
/// 4. The creator is paid the total tipped and the tipper is refunded the rest
///
/// ## Key Features:
/// - Gasless tipping: no on-chain transaction per tip
/// - Settlement gated on the tipper's signature, submittable by anyone but the tipper
/// - Trust-minimized timeout refund if no relayer ever settles
module sui_tunnel::example_gasless_tipping;

use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui_tunnel::signature;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidSignature: vector<u8> = b"Signature verification failed.";

#[error]
const EInvalidPublicKey: vector<u8> = b"The public key is invalid or has the wrong length for its scheme.";

#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

#[error]
const EInvalidNonce: vector<u8> = b"The nonce is invalid; it must be strictly increasing.";

#[error]
const ETimeoutNotReached: vector<u8> = b"The timeout has not been reached yet.";

#[error]
const EInsufficientBalance: vector<u8> = b"Insufficient balance for this operation.";

#[error]
const ERegressingTotal: vector<u8> = b"The running total cannot regress below the committed total.";

#[error]
const EInvalidDepositAmount: vector<u8> = b"The deposit amount is invalid.";

// ============================================
// CONSTANTS
// ============================================

/// Channel status: Open for off-chain tips
const TIP_OPEN: u8 = 0;

/// Channel status: Settled once on-chain
const TIP_SETTLED: u8 = 1;

/// Channel status: Refunded to the tipper after timeout
const TIP_REFUNDED: u8 = 2;

/// Refund timeout: 24 hours
const REFUND_TIMEOUT_MS: u64 = 86400000;

// ============================================
// STRUCTS
// ============================================

/// A one-directional micro-tipping channel from a single tipper to one creator.
/// Only the tipper funds the pot; settlement pays the creator the running total
/// and refunds the unused remainder to the tipper.
public struct TipChannel<phantom T> has key, store {
    id: UID,
    /// Tipper who funds the pot and signs running totals
    tipper: address,
    /// Creator who receives the tips on settlement
    creator: address,
    /// Tipper's public key for signature verification
    tipper_pk: vector<u8>,
    /// Pot held in the channel
    funds: Balance<T>,
    /// Total amount the tipper deposited
    total_deposited: u64,
    /// Last settled or committed running total
    total_tipped: u64,
    /// Latest committed state nonce
    nonce: u64,
    /// Current channel status
    status: u8,
    /// Channel creation timestamp in milliseconds
    created_at_ms: u64,
    /// Timestamp after which the tipper may reclaim the pot
    refund_after_ms: u64,
}

/// Off-chain tip state signed by the tipper as a running total.
public struct TipState has copy, drop, store {
    /// Channel ID the state belongs to
    channel_id: vector<u8>,
    /// State nonce (must be strictly increasing)
    nonce: u64,
    /// Cumulative amount tipped so far
    total_tipped: u64,
}

/// A tip state with the tipper's signature over it.
public struct SignedTip has copy, drop, store {
    /// The tip state
    state: TipState,
    /// Signature from the tipper
    tipper_sig: vector<u8>,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a tipping channel is opened
public struct TipChannelOpened has copy, drop {
    tipper: address,
    creator: address,
    deposit: u64,
}

/// Emitted when the channel is settled on-chain
public struct TipsSettled has copy, drop {
    tipper: address,
    creator: address,
    total_tipped: u64,
    refund: u64,
}

/// Emitted when the pot is refunded to the tipper after timeout
public struct TipsRefunded has copy, drop {
    tipper: address,
    amount: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS
// ============================================

public fun tip_open(): u8 { TIP_OPEN }

public fun tip_settled(): u8 { TIP_SETTLED }

public fun tip_refunded(): u8 { TIP_REFUNDED }

public fun refund_timeout_ms(): u64 { REFUND_TIMEOUT_MS }

// ============================================
// CHANNEL LIFECYCLE
// ============================================

/// Opens a tipping channel funded by the sender toward a single creator.
/// The deposit must be non-zero, the tipper and creator must differ, and the
/// tipper public key must be non-empty. The refund window starts now.
public fun open_tip_channel<T>(
    creator: address,
    deposit: Coin<T>,
    tipper_pk: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): TipChannel<T> {
    let tipper = ctx.sender();
    let funds = deposit.into_balance();
    let total_deposited = funds.value();

    assert!(total_deposited > 0, EInvalidDepositAmount);
    assert!(tipper != creator, EInvalidParties);
    assert!(tipper_pk.length() > 0, EInvalidPublicKey);

    let now = clock.timestamp_ms();

    event::emit(TipChannelOpened { tipper, creator, deposit: total_deposited });

    TipChannel {
        id: object::new(ctx),
        tipper,
        creator,
        tipper_pk,
        funds,
        total_deposited,
        total_tipped: 0,
        nonce: 0,
        status: TIP_OPEN,
        created_at_ms: now,
        refund_after_ms: now + REFUND_TIMEOUT_MS,
    }
}

// ============================================
// STATE UPDATES (OFF-CHAIN COORDINATION)
// ============================================

/// Builds the domain-separated bytes the tipper signs for a running total.
public fun build_tip_state_bytes(
    channel_id: &vector<u8>,
    nonce: u64,
    total_tipped: u64,
): vector<u8> {
    let mut data = b"tipping::settle";
    data.append(*channel_id);
    data.append(signature::u64_to_be_bytes(nonce));
    data.append(signature::u64_to_be_bytes(total_tipped));
    data
}

/// Constructs an off-chain tip state.
public fun create_tip_state(channel_id: vector<u8>, nonce: u64, total_tipped: u64): TipState {
    TipState { channel_id, nonce, total_tipped }
}

/// Wraps a tip state with the tipper's signature.
public fun create_signed_tip(state: TipState, tipper_sig: vector<u8>): SignedTip {
    SignedTip { state, tipper_sig }
}

// ============================================
// SETTLEMENT
// ============================================

/// Settles the channel once on-chain from the tipper's latest signed total.
/// This is the gasless path: callable by the creator or any relayer, because it
/// is gated on the tipper's signature instead of a sender check. The tipper is
/// barred because settlement is terminal and the running-total guard is vacuous
/// before the single settle, so the tipper could pick an old, low-total voucher
/// to underpay the creator and keep a larger refund; the timeout `refund_tipper`
/// remains the tipper's only self-serve exit. The nonce must strictly increase,
/// the total must not exceed the deposit and must not regress below the committed
/// total, and the tipper's signature must verify. The creator is paid the running
/// total and the tipper is refunded the remainder.
/// Transfers coins directly to the parties to prevent fund redirection in PTBs.
public fun settle_tips<T>(
    channel: &mut TipChannel<T>,
    total_tipped: u64,
    nonce: u64,
    tipper_sig: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() != channel.tipper, ENotAuthorized);
    assert_settle_guards(channel, total_tipped, nonce);

    let channel_id = channel.id.uid_to_bytes();
    let msg = build_tip_state_bytes(&channel_id, nonce, total_tipped);
    assert!(signature::verify_ed25519(&channel.tipper_pk, &msg, &tipper_sig), EInvalidSignature);

    settle_payout(channel, total_tipped, nonce, ctx);
}

/// Shared settlement preconditions: channel open, nonce strictly increasing,
/// total within the deposit and not regressing below the committed total.
fun assert_settle_guards<T>(channel: &TipChannel<T>, total_tipped: u64, nonce: u64) {
    assert!(channel.status == TIP_OPEN, EInvalidState);
    assert!(nonce > channel.nonce, EInvalidNonce);
    assert!(total_tipped <= channel.total_deposited, EInsufficientBalance);
    assert!(total_tipped >= channel.total_tipped, ERegressingTotal);
}

/// Refunds the entire pot to the tipper after the refund window.
/// Only the tipper may call this, the channel must still be open, and the
/// timeout must have elapsed. This is the trust-minimized exit when no relayer
/// ever settles. Transfers coins directly to the parties to prevent fund
/// redirection in PTBs.
public fun refund_tipper<T>(channel: &mut TipChannel<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(ctx.sender() == channel.tipper, ENotAuthorized);
    assert!(channel.status == TIP_OPEN, EInvalidState);
    assert!(clock.timestamp_ms() >= channel.refund_after_ms, ETimeoutNotReached);

    channel.status = TIP_REFUNDED;

    let amount = channel.funds.value();

    event::emit(TipsRefunded { tipper: channel.tipper, amount });

    let refund = coin::from_balance(channel.funds.withdraw_all(), ctx);
    transfer::public_transfer(refund, channel.tipper);
}

/// Records the settled total and pays the creator and tipper.
fun settle_payout<T>(
    channel: &mut TipChannel<T>,
    total_tipped: u64,
    nonce: u64,
    ctx: &mut TxContext,
) {
    channel.status = TIP_SETTLED;
    channel.nonce = nonce;
    channel.total_tipped = total_tipped;

    let refund = channel.total_deposited - total_tipped;

    event::emit(TipsSettled {
        tipper: channel.tipper,
        creator: channel.creator,
        total_tipped,
        refund,
    });

    let creator_coin = coin::from_balance(channel.funds.split(total_tipped), ctx);
    let tipper_coin = coin::from_balance(channel.funds.withdraw_all(), ctx);

    transfer::public_transfer(creator_coin, channel.creator);
    transfer::public_transfer(tipper_coin, channel.tipper);
}

// ============================================
// ACCESSORS
// ============================================

public fun channel_id<T>(channel: &TipChannel<T>): vector<u8> { channel.id.uid_to_bytes() }

public fun channel_tipper<T>(channel: &TipChannel<T>): address { channel.tipper }

public fun channel_creator<T>(channel: &TipChannel<T>): address { channel.creator }

public fun channel_tipper_pk<T>(channel: &TipChannel<T>): &vector<u8> { &channel.tipper_pk }

public fun channel_total_deposited<T>(channel: &TipChannel<T>): u64 { channel.total_deposited }

public fun channel_total_tipped<T>(channel: &TipChannel<T>): u64 { channel.total_tipped }

public fun channel_nonce<T>(channel: &TipChannel<T>): u64 { channel.nonce }

public fun channel_status<T>(channel: &TipChannel<T>): u8 { channel.status }

public fun channel_balance<T>(channel: &TipChannel<T>): u64 { channel.funds.value() }

public fun channel_refund_after<T>(channel: &TipChannel<T>): u64 { channel.refund_after_ms }

public fun is_open<T>(channel: &TipChannel<T>): bool { channel.status == TIP_OPEN }

public fun can_refund<T>(channel: &TipChannel<T>, clock: &Clock): bool {
    channel.status == TIP_OPEN && clock.timestamp_ms() >= channel.refund_after_ms
}

// TipState accessors
public fun tip_state_channel_id(state: &TipState): &vector<u8> { &state.channel_id }

public fun tip_state_nonce(state: &TipState): u64 { state.nonce }

public fun tip_state_total_tipped(state: &TipState): u64 { state.total_tipped }

// SignedTip accessors
public fun signed_tip_state(st: &SignedTip): &TipState { &st.state }

public fun signed_tip_sig(st: &SignedTip): &vector<u8> { &st.tipper_sig }

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_tip_channel_for_testing<T>(channel: TipChannel<T>) {
    let TipChannel { id, funds, .. } = channel;
    id.delete();
    funds.destroy_for_testing();
}

#[test_only]
public fun set_status_for_testing<T>(channel: &mut TipChannel<T>, status: u8) {
    channel.status = status;
}

#[test_only]
public fun settle_tips_no_sig_for_testing<T>(
    channel: &mut TipChannel<T>,
    total_tipped: u64,
    nonce: u64,
    ctx: &mut TxContext,
) {
    assert_settle_guards(channel, total_tipped, nonce);

    settle_payout(channel, total_tipped, nonce, ctx);
}
