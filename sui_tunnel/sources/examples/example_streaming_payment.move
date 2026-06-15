/// Example: Streaming Payment
///
/// Time-based payment streams where funds unlock linearly over time.
/// Useful for salaries, subscriptions, vesting schedules.
///
/// ## Flow:
/// 1. Sender creates a stream with total amount and duration
/// 2. Recipient can withdraw unlocked funds at any time
/// 3. Sender can cancel remaining stream (pro-rata refund)
///
/// ## Key Features:
/// - Linear unlock over time
/// - Partial withdrawals
/// - Cancellation with refund
/// - Multiple concurrent streams
module sui_tunnel::example_streaming_payment;

use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const ETimeoutReached: vector<u8> = b"The timeout has already been reached.";

#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

#[error]
const EInvalidTimeout: vector<u8> = b"The timeout value is invalid.";

#[error]
const EInsufficientBalance: vector<u8> = b"Insufficient balance for this operation.";

#[error]
const EInvalidDepositAmount: vector<u8> = b"The deposit amount is invalid.";

// ============================================
// CONSTANTS
// ============================================

/// Stream status: Active
const STATUS_ACTIVE: u8 = 0;

/// Stream status: Completed (fully withdrawn)
const STATUS_COMPLETED: u8 = 1;

/// Stream status: Cancelled
const STATUS_CANCELLED: u8 = 2;

/// Minimum stream duration: 1 hour
const MIN_DURATION_MS: u64 = 3600000;

// ============================================
// STRUCTS
// ============================================

/// A payment stream from sender to recipient
public struct PaymentStream<phantom T> has key, store {
    id: UID,
    /// Sender (creator)
    sender: address,
    /// Recipient
    recipient: address,
    /// Total amount in the stream
    total_amount: u64,
    /// Amount already withdrawn
    withdrawn_amount: u64,
    /// Remaining funds
    funds: Balance<T>,
    /// Stream start time
    start_time_ms: u64,
    /// Stream end time
    end_time_ms: u64,
    /// Description/memo
    memo: vector<u8>,
    /// Current status
    status: u8,
}

/// Receipt for a withdrawal
public struct WithdrawalReceipt has copy, drop, store {
    /// Stream ID
    stream_id: vector<u8>,
    /// Amount withdrawn
    amount: u64,
    /// Withdrawal timestamp
    timestamp_ms: u64,
    /// Total withdrawn so far
    total_withdrawn: u64,
}

/// Receipt for stream cancellation
public struct CancellationReceipt has copy, drop, store {
    /// Stream ID
    stream_id: vector<u8>,
    /// Amount refunded to sender
    refunded_amount: u64,
    /// Amount already received by recipient
    recipient_received: u64,
    /// Cancellation timestamp
    timestamp_ms: u64,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a stream is created
public struct StreamCreated has copy, drop {
    sender: address,
    recipient: address,
    total_amount: u64,
    start_time_ms: u64,
    end_time_ms: u64,
}

/// Emitted when funds are withdrawn
public struct StreamWithdrawn has copy, drop {
    recipient: address,
    amount: u64,
    total_withdrawn: u64,
}

/// Emitted when a stream is cancelled
public struct StreamCancelled has copy, drop {
    sender: address,
    recipient: address,
    refunded_amount: u64,
    recipient_received: u64,
}

/// Emitted when a stream is completed
public struct StreamCompleted has copy, drop {
    sender: address,
    recipient: address,
    total_amount: u64,
}

/// Emitted when a stream is topped up
public struct StreamTopUp has copy, drop {
    sender: address,
    amount: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS
// ============================================

public fun status_active(): u8 { STATUS_ACTIVE }

public fun status_completed(): u8 { STATUS_COMPLETED }

public fun status_cancelled(): u8 { STATUS_CANCELLED }

public fun min_duration_ms(): u64 { MIN_DURATION_MS }

// ============================================
// STREAM LIFECYCLE
// ============================================

/// Create a new payment stream
public fun create_stream<T>(
    recipient: address,
    payment: Coin<T>,
    duration_ms: u64,
    memo: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): PaymentStream<T> {
    let sender = ctx.sender();
    assert!(sender != recipient, EInvalidParties);

    let total_amount = payment.value();
    assert!(total_amount > 0, EInvalidDepositAmount);
    assert!(duration_ms >= MIN_DURATION_MS, EInvalidTimeout);

    let now = clock.timestamp_ms();

    let stream = PaymentStream {
        id: object::new(ctx),
        sender,
        recipient,
        total_amount,
        withdrawn_amount: 0,
        funds: payment.into_balance(),
        start_time_ms: now,
        end_time_ms: now + duration_ms,
        memo,
        status: STATUS_ACTIVE,
    };

    event::emit(StreamCreated {
        sender,
        recipient,
        total_amount,
        start_time_ms: now,
        end_time_ms: now + duration_ms,
    });

    stream
}

/// Withdraw unlocked funds (recipient only).
/// Funds are transferred directly to the recipient to prevent PTB interception.
public fun withdraw<T>(
    stream: &mut PaymentStream<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): WithdrawalReceipt {
    assert!(ctx.sender() == stream.recipient, ENotAuthorized);
    assert!(stream.status == STATUS_ACTIVE, EInvalidState);

    let now = clock.timestamp_ms();

    let unlocked = calculate_unlocked(stream, now);
    let available = unlocked - stream.withdrawn_amount;
    assert!(available > 0, EInsufficientBalance);

    stream.withdrawn_amount = unlocked;

    // Check if stream is complete
    if (stream.withdrawn_amount >= stream.total_amount) {
        stream.status = STATUS_COMPLETED;
    };

    let coins = coin::from_balance(stream.funds.split(available), ctx);
    transfer::public_transfer(coins, stream.recipient);

    let receipt = WithdrawalReceipt {
        stream_id: stream.id.to_bytes(),
        amount: available,
        timestamp_ms: now,
        total_withdrawn: stream.withdrawn_amount,
    };

    event::emit(StreamWithdrawn {
        recipient: stream.recipient,
        amount: available,
        total_withdrawn: stream.withdrawn_amount,
    });

    if (stream.status == STATUS_COMPLETED) {
        event::emit(StreamCompleted {
            sender: stream.sender,
            recipient: stream.recipient,
            total_amount: stream.total_amount,
        });
    };

    receipt
}

/// Withdraw a specific amount (up to what's unlocked).
/// Funds are transferred directly to the recipient to prevent PTB interception.
public fun withdraw_amount<T>(
    stream: &mut PaymentStream<T>,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): WithdrawalReceipt {
    assert!(ctx.sender() == stream.recipient, ENotAuthorized);
    assert!(stream.status == STATUS_ACTIVE, EInvalidState);

    let now = clock.timestamp_ms();

    let unlocked = calculate_unlocked(stream, now);
    let available = unlocked - stream.withdrawn_amount;
    assert!(amount > 0 && amount <= available, EInsufficientBalance);

    stream.withdrawn_amount = stream.withdrawn_amount + amount;

    // Check if stream is complete
    if (stream.withdrawn_amount >= stream.total_amount) {
        stream.status = STATUS_COMPLETED;
    };

    let coins = coin::from_balance(stream.funds.split(amount), ctx);
    transfer::public_transfer(coins, stream.recipient);

    let receipt = WithdrawalReceipt {
        stream_id: stream.id.to_bytes(),
        amount,
        timestamp_ms: now,
        total_withdrawn: stream.withdrawn_amount,
    };

    event::emit(StreamWithdrawn {
        recipient: stream.recipient,
        amount,
        total_withdrawn: stream.withdrawn_amount,
    });

    if (stream.status == STATUS_COMPLETED) {
        event::emit(StreamCompleted {
            sender: stream.sender,
            recipient: stream.recipient,
            total_amount: stream.total_amount,
        });
    };

    receipt
}

/// Cancel the stream and refund remaining funds to sender.
/// Recipient's earned funds and sender's refund are transferred directly
/// to their respective parties to prevent PTB interception.
public fun cancel_stream<T>(
    stream: &mut PaymentStream<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): CancellationReceipt {
    assert!(ctx.sender() == stream.sender, ENotAuthorized);
    assert!(stream.status == STATUS_ACTIVE, EInvalidState);

    let now = clock.timestamp_ms();

    // Calculate what recipient has earned
    let unlocked = calculate_unlocked(stream, now);
    let recipient_owed = unlocked - stream.withdrawn_amount;
    let refund_amount = stream.funds.value() - recipient_owed;

    stream.status = STATUS_CANCELLED;

    // Transfer recipient's earned funds directly
    if (recipient_owed > 0) {
        let recipient_coins = coin::from_balance(stream.funds.split(recipient_owed), ctx);
        transfer::public_transfer(recipient_coins, stream.recipient);
    };

    // Transfer sender's refund directly
    if (refund_amount > 0) {
        let remaining = stream.funds.value();
        let refund_coins = coin::from_balance(stream.funds.split(remaining), ctx);
        transfer::public_transfer(refund_coins, stream.sender);
    };

    let receipt = CancellationReceipt {
        stream_id: stream.id.to_bytes(),
        refunded_amount: refund_amount,
        recipient_received: stream.withdrawn_amount + recipient_owed,
        timestamp_ms: now,
    };

    event::emit(StreamCancelled {
        sender: stream.sender,
        recipient: stream.recipient,
        refunded_amount: refund_amount,
        recipient_received: stream.withdrawn_amount + recipient_owed,
    });

    receipt
}

/// Top up an existing stream
public fun top_up<T>(
    stream: &mut PaymentStream<T>,
    additional: Coin<T>,
    additional_duration_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == stream.sender, ENotAuthorized);
    assert!(stream.status == STATUS_ACTIVE, EInvalidState);

    let now = clock.timestamp_ms();
    assert!(now < stream.end_time_ms, ETimeoutReached);

    let additional_amount = additional.value();
    assert!(additional_amount > 0, EInvalidDepositAmount);
    assert!(additional_duration_ms > 0, EInvalidParameter);

    // Snapshot the current unlocked amount BEFORE modifying stream parameters.
    // This prevents a sender from flattening the unlocking curve to re-lock
    // funds that the recipient has already earned (vested) but not yet withdrawn.
    // Checking against withdrawn_amount alone is insufficient: if the recipient
    // has 500 vested but only 100 withdrawn, a malicious top_up could reduce
    // unlocked to 101 (>= withdrawn) while stealing 399 of vested funds.
    let prev_unlocked = calculate_unlocked(stream, now);

    stream.total_amount = stream.total_amount + additional_amount;
    stream.funds.join(additional.into_balance());
    stream.end_time_ms = stream.end_time_ms + additional_duration_ms;

    let new_unlocked = calculate_unlocked(stream, now);
    assert!(new_unlocked >= prev_unlocked, EInvalidParameter);

    event::emit(StreamTopUp { sender: ctx.sender(), amount: additional_amount });
}

// ============================================
// VIEW FUNCTIONS
// ============================================

/// Calculate unlocked amount at a given time
public fun calculate_unlocked<T>(stream: &PaymentStream<T>, current_time_ms: u64): u64 {
    if (current_time_ms <= stream.start_time_ms) {
        0
    } else if (current_time_ms >= stream.end_time_ms) {
        stream.total_amount
    } else {
        let elapsed = current_time_ms - stream.start_time_ms;
        let duration = stream.end_time_ms - stream.start_time_ms;
        (((stream.total_amount as u128) * (elapsed as u128)) / (duration as u128) as u64)
    }
}

/// Get available (unlocked but not withdrawn) amount
public fun available_balance<T>(stream: &PaymentStream<T>, current_time_ms: u64): u64 {
    let unlocked = calculate_unlocked(stream, current_time_ms);
    if (unlocked > stream.withdrawn_amount) {
        unlocked - stream.withdrawn_amount
    } else {
        0
    }
}

/// Get remaining (locked) amount
public fun remaining_balance<T>(stream: &PaymentStream<T>, current_time_ms: u64): u64 {
    let unlocked = calculate_unlocked(stream, current_time_ms);
    stream.total_amount - unlocked
}

/// Calculate streaming rate (per millisecond)
public fun rate_per_ms<T>(stream: &PaymentStream<T>): u64 {
    let duration = stream.end_time_ms - stream.start_time_ms;
    stream.total_amount / duration
}

// ============================================
// ACCESSORS
// ============================================

public fun stream_sender<T>(stream: &PaymentStream<T>): address { stream.sender }

public fun stream_recipient<T>(stream: &PaymentStream<T>): address { stream.recipient }

public fun stream_total_amount<T>(stream: &PaymentStream<T>): u64 { stream.total_amount }

public fun stream_withdrawn_amount<T>(stream: &PaymentStream<T>): u64 { stream.withdrawn_amount }

public fun stream_start_time<T>(stream: &PaymentStream<T>): u64 { stream.start_time_ms }

public fun stream_end_time<T>(stream: &PaymentStream<T>): u64 { stream.end_time_ms }

public fun stream_status<T>(stream: &PaymentStream<T>): u8 { stream.status }

public fun stream_memo<T>(stream: &PaymentStream<T>): &vector<u8> { &stream.memo }

public fun stream_is_active<T>(stream: &PaymentStream<T>): bool {
    stream.status == STATUS_ACTIVE
}

// Receipt accessors
public fun withdrawal_stream_id(receipt: &WithdrawalReceipt): &vector<u8> { &receipt.stream_id }

public fun withdrawal_amount(receipt: &WithdrawalReceipt): u64 { receipt.amount }

public fun withdrawal_timestamp(receipt: &WithdrawalReceipt): u64 { receipt.timestamp_ms }

public fun cancellation_refunded(receipt: &CancellationReceipt): u64 { receipt.refunded_amount }

public fun cancellation_recipient_received(receipt: &CancellationReceipt): u64 {
    receipt.recipient_received
}
