/// Example: Streaming Payroll
///
/// Salary streams where pay vests linearly by the second over the pay period.
/// Useful for continuous payroll, contractor retainers, and vesting grants.
///
/// ## Flow:
/// 1. Employer starts a salary stream with the total amount and a duration
/// 2. Employee can claim vested salary at any time
/// 3. Employer can cancel the remaining stream (pro-rata refund)
///
/// ## Key Features:
/// - Linear vesting over time
/// - Partial claims
/// - Cancellation with refund
/// - Per-second pay rate view
module sui_tunnel::example_streaming_payroll;

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

/// Salary status: Active
const STATUS_ACTIVE: u8 = 0;

/// Salary status: Completed (fully claimed)
const STATUS_COMPLETED: u8 = 1;

/// Salary status: Cancelled
const STATUS_CANCELLED: u8 = 2;

/// Minimum pay period: 1 hour
const MIN_DURATION_MS: u64 = 3600000;

// ============================================
// STRUCTS
// ============================================

/// A salary stream from employer to employee
public struct SalaryStream<phantom T> has key, store {
    id: UID,
    /// Employer (creator)
    employer: address,
    /// Employee
    employee: address,
    /// Total amount in the stream
    total_amount: u64,
    /// Amount already claimed
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

/// Receipt for a claim
public struct WithdrawalReceipt has copy, drop, store {
    /// Salary stream ID
    stream_id: vector<u8>,
    /// Amount claimed
    amount: u64,
    /// Claim timestamp
    timestamp_ms: u64,
    /// Total claimed so far
    total_withdrawn: u64,
}

/// Receipt for stream cancellation
public struct CancellationReceipt has copy, drop, store {
    /// Salary stream ID
    stream_id: vector<u8>,
    /// Amount refunded to employer
    refunded_amount: u64,
    /// Amount already received by employee
    recipient_received: u64,
    /// Cancellation timestamp
    timestamp_ms: u64,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a salary stream is started
public struct SalaryStarted has copy, drop {
    employer: address,
    employee: address,
    total_amount: u64,
    start_time_ms: u64,
    end_time_ms: u64,
}

/// Emitted when salary is claimed
public struct SalaryWithdrawn has copy, drop {
    employee: address,
    amount: u64,
    total_withdrawn: u64,
}

/// Emitted when a salary stream is cancelled
public struct SalaryCancelled has copy, drop {
    employer: address,
    employee: address,
    refunded_amount: u64,
    recipient_received: u64,
}

/// Emitted when a salary stream is completed
public struct SalaryCompleted has copy, drop {
    employer: address,
    employee: address,
    total_amount: u64,
}

/// Emitted when a salary stream is topped up
public struct SalaryToppedUp has copy, drop {
    employer: address,
    amount: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS
// ============================================

/// Status code for a stream that is still vesting.
public fun status_active(): u8 { STATUS_ACTIVE }

/// Status code for a stream whose full total has been claimed.
public fun status_completed(): u8 { STATUS_COMPLETED }

/// Status code for a stream cancelled by the employer.
public fun status_cancelled(): u8 { STATUS_CANCELLED }

/// Shortest pay period a stream may span, in milliseconds.
public fun min_duration_ms(): u64 { MIN_DURATION_MS }

// ============================================
// SALARY LIFECYCLE
// ============================================

/// Start a new salary stream
public fun start_salary<T>(
    employee: address,
    payment: Coin<T>,
    duration_ms: u64,
    memo: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): SalaryStream<T> {
    let employer = ctx.sender();
    assert!(employer != employee, EInvalidParties);

    let total_amount = payment.value();
    assert!(total_amount > 0, EInvalidDepositAmount);
    assert!(duration_ms >= MIN_DURATION_MS, EInvalidTimeout);

    let now = clock.timestamp_ms();

    let salary = SalaryStream {
        id: object::new(ctx),
        employer,
        employee,
        total_amount,
        withdrawn_amount: 0,
        funds: payment.into_balance(),
        start_time_ms: now,
        end_time_ms: now + duration_ms,
        memo,
        status: STATUS_ACTIVE,
    };

    event::emit(SalaryStarted {
        employer,
        employee,
        total_amount,
        start_time_ms: now,
        end_time_ms: now + duration_ms,
    });

    salary
}

/// Claim vested salary (employee only).
/// Funds are transferred directly to the employee to prevent PTB interception.
public fun claim_salary<T>(
    salary: &mut SalaryStream<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): WithdrawalReceipt {
    assert!(ctx.sender() == salary.employee, ENotAuthorized);
    assert!(salary.status == STATUS_ACTIVE, EInvalidState);

    let now = clock.timestamp_ms();

    let unlocked = calculate_unlocked(salary, now);
    let available = unlocked - salary.withdrawn_amount;
    assert!(available > 0, EInsufficientBalance);

    salary.withdrawn_amount = unlocked;

    // Check if stream is complete
    if (salary.withdrawn_amount >= salary.total_amount) {
        salary.status = STATUS_COMPLETED;
    };

    let coins = coin::from_balance(salary.funds.split(available), ctx);
    transfer::public_transfer(coins, salary.employee);

    let receipt = WithdrawalReceipt {
        stream_id: salary.id.to_bytes(),
        amount: available,
        timestamp_ms: now,
        total_withdrawn: salary.withdrawn_amount,
    };

    event::emit(SalaryWithdrawn {
        employee: salary.employee,
        amount: available,
        total_withdrawn: salary.withdrawn_amount,
    });

    if (salary.status == STATUS_COMPLETED) {
        event::emit(SalaryCompleted {
            employer: salary.employer,
            employee: salary.employee,
            total_amount: salary.total_amount,
        });
    };

    receipt
}

/// Claim a specific amount (up to what's vested).
/// Funds are transferred directly to the employee to prevent PTB interception.
public fun claim_salary_amount<T>(
    salary: &mut SalaryStream<T>,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): WithdrawalReceipt {
    assert!(ctx.sender() == salary.employee, ENotAuthorized);
    assert!(salary.status == STATUS_ACTIVE, EInvalidState);

    let now = clock.timestamp_ms();

    let unlocked = calculate_unlocked(salary, now);
    let available = unlocked - salary.withdrawn_amount;
    assert!(amount > 0 && amount <= available, EInsufficientBalance);

    salary.withdrawn_amount = salary.withdrawn_amount + amount;

    // Check if stream is complete
    if (salary.withdrawn_amount >= salary.total_amount) {
        salary.status = STATUS_COMPLETED;
    };

    let coins = coin::from_balance(salary.funds.split(amount), ctx);
    transfer::public_transfer(coins, salary.employee);

    let receipt = WithdrawalReceipt {
        stream_id: salary.id.to_bytes(),
        amount,
        timestamp_ms: now,
        total_withdrawn: salary.withdrawn_amount,
    };

    event::emit(SalaryWithdrawn {
        employee: salary.employee,
        amount,
        total_withdrawn: salary.withdrawn_amount,
    });

    if (salary.status == STATUS_COMPLETED) {
        event::emit(SalaryCompleted {
            employer: salary.employer,
            employee: salary.employee,
            total_amount: salary.total_amount,
        });
    };

    receipt
}

/// Cancel the salary stream and refund remaining funds to employer.
/// Employee's earned funds and employer's refund are transferred directly
/// to their respective parties to prevent PTB interception.
public fun cancel_salary<T>(
    salary: &mut SalaryStream<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): CancellationReceipt {
    assert!(ctx.sender() == salary.employer, ENotAuthorized);
    assert!(salary.status == STATUS_ACTIVE, EInvalidState);

    let now = clock.timestamp_ms();

    // Calculate what employee has earned
    let unlocked = calculate_unlocked(salary, now);
    let recipient_owed = unlocked - salary.withdrawn_amount;
    let refund_amount = salary.funds.value() - recipient_owed;

    salary.status = STATUS_CANCELLED;

    // Transfer employee's earned funds directly
    if (recipient_owed > 0) {
        let recipient_coins = coin::from_balance(salary.funds.split(recipient_owed), ctx);
        transfer::public_transfer(recipient_coins, salary.employee);
    };

    // Transfer employer's refund directly
    if (refund_amount > 0) {
        let remaining = salary.funds.value();
        let refund_coins = coin::from_balance(salary.funds.split(remaining), ctx);
        transfer::public_transfer(refund_coins, salary.employer);
    };

    let receipt = CancellationReceipt {
        stream_id: salary.id.to_bytes(),
        refunded_amount: refund_amount,
        recipient_received: salary.withdrawn_amount + recipient_owed,
        timestamp_ms: now,
    };

    event::emit(SalaryCancelled {
        employer: salary.employer,
        employee: salary.employee,
        refunded_amount: refund_amount,
        recipient_received: salary.withdrawn_amount + recipient_owed,
    });

    receipt
}

/// Top up an existing salary stream
public fun top_up_salary<T>(
    salary: &mut SalaryStream<T>,
    additional: Coin<T>,
    additional_duration_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == salary.employer, ENotAuthorized);
    assert!(salary.status == STATUS_ACTIVE, EInvalidState);

    let now = clock.timestamp_ms();
    assert!(now < salary.end_time_ms, ETimeoutReached);

    let additional_amount = additional.value();
    assert!(additional_amount > 0, EInvalidDepositAmount);
    assert!(additional_duration_ms > 0, EInvalidParameter);

    // Snapshot the current vested amount BEFORE modifying stream parameters.
    // This prevents an employer from flattening the vesting curve to re-lock
    // funds that the employee has already earned (vested) but not yet claimed.
    // Checking against withdrawn_amount alone is insufficient: if the employee
    // has 500 vested but only 100 claimed, a malicious top up could reduce
    // unlocked to 101 (>= withdrawn) while stealing 399 of vested funds.
    let prev_unlocked = calculate_unlocked(salary, now);

    salary.total_amount = salary.total_amount + additional_amount;
    salary.funds.join(additional.into_balance());
    salary.end_time_ms = salary.end_time_ms + additional_duration_ms;

    let new_unlocked = calculate_unlocked(salary, now);
    assert!(new_unlocked >= prev_unlocked, EInvalidParameter);

    event::emit(SalaryToppedUp { employer: ctx.sender(), amount: additional_amount });
}

// ============================================
// VIEW FUNCTIONS
// ============================================

/// Calculate vested amount at a given time
public fun calculate_unlocked<T>(salary: &SalaryStream<T>, current_time_ms: u64): u64 {
    if (current_time_ms <= salary.start_time_ms) {
        0
    } else if (current_time_ms >= salary.end_time_ms) {
        salary.total_amount
    } else {
        let elapsed = current_time_ms - salary.start_time_ms;
        let duration = salary.end_time_ms - salary.start_time_ms;
        (((salary.total_amount as u128) * (elapsed as u128)) / (duration as u128) as u64)
    }
}

/// Get available (vested but not claimed) amount
public fun available_balance<T>(salary: &SalaryStream<T>, current_time_ms: u64): u64 {
    let unlocked = calculate_unlocked(salary, current_time_ms);
    if (unlocked > salary.withdrawn_amount) {
        unlocked - salary.withdrawn_amount
    } else {
        0
    }
}

/// Get remaining (unvested) amount
public fun remaining_balance<T>(salary: &SalaryStream<T>, current_time_ms: u64): u64 {
    let unlocked = calculate_unlocked(salary, current_time_ms);
    salary.total_amount - unlocked
}

/// Calculate pay rate per millisecond
public fun rate_per_ms<T>(salary: &SalaryStream<T>): u64 {
    let duration = salary.end_time_ms - salary.start_time_ms;
    salary.total_amount / duration
}

/// Calculate pay rate per second.
/// A sub-second pay period cannot express a per-second rate, so the full total
/// is returned. This differs from rate_per_ms, which does not special-case such
/// windows.
public fun rate_per_second<T>(salary: &SalaryStream<T>): u64 {
    let duration_seconds = (salary.end_time_ms - salary.start_time_ms) / 1000;
    if (duration_seconds == 0) {
        // Defensive only: start_salary enforces MIN_DURATION_MS, so a sub-second window is unreachable through the public constructor.
        salary.total_amount
    } else {
        salary.total_amount / duration_seconds
    }
}

// ============================================
// ACCESSORS
// ============================================

/// Address funding the stream.
public fun salary_employer<T>(salary: &SalaryStream<T>): address { salary.employer }

/// Address that vests and claims the stream.
public fun salary_employee<T>(salary: &SalaryStream<T>): address { salary.employee }

/// Total amount the stream pays out over its full period.
public fun salary_total_amount<T>(salary: &SalaryStream<T>): u64 { salary.total_amount }

/// Amount already claimed by the employee.
public fun salary_withdrawn_amount<T>(salary: &SalaryStream<T>): u64 { salary.withdrawn_amount }

/// Stream start time in milliseconds.
public fun salary_start_time<T>(salary: &SalaryStream<T>): u64 { salary.start_time_ms }

/// Stream end time in milliseconds, when the full total has vested.
public fun salary_end_time<T>(salary: &SalaryStream<T>): u64 { salary.end_time_ms }

/// Current lifecycle status code of the stream.
public fun salary_status<T>(salary: &SalaryStream<T>): u8 { salary.status }

/// Free-form memo attached to the stream.
public fun salary_memo<T>(salary: &SalaryStream<T>): &vector<u8> { &salary.memo }

/// Whether the stream is still active (vesting).
public fun salary_is_active<T>(salary: &SalaryStream<T>): bool {
    salary.status == STATUS_ACTIVE
}

// Receipt accessors

/// Object ID of the stream the claim was drawn from.
public fun withdrawal_stream_id(receipt: &WithdrawalReceipt): &vector<u8> { &receipt.stream_id }

/// Amount claimed in this withdrawal.
public fun withdrawal_amount(receipt: &WithdrawalReceipt): u64 { receipt.amount }

/// Timestamp of the withdrawal in milliseconds.
public fun withdrawal_timestamp(receipt: &WithdrawalReceipt): u64 { receipt.timestamp_ms }

/// Amount refunded to the employer on cancellation.
public fun cancellation_refunded(receipt: &CancellationReceipt): u64 { receipt.refunded_amount }

/// Total amount the employee received before cancellation.
public fun cancellation_recipient_received(receipt: &CancellationReceipt): u64 {
    receipt.recipient_received
}
