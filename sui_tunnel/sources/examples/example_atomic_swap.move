/// Example: Atomic Swap
///
/// Hash Time-Locked Contract (HTLC) based atomic swap between two parties.
/// Enables trustless exchange without a trusted third party.
///
/// ## Flow:
/// 1. Alice wants to trade with Bob
/// 2. Alice creates a secret and locks her coins with hash(secret)
/// 3. Bob locks his coins with the same hash
/// 4. Alice reveals secret to claim Bob's coins
/// 5. Bob uses revealed secret to claim Alice's coins
///
/// ## Key Features:
/// - Trustless exchange
/// - Timeout protection
/// - Works across different coin types
/// - Cascading timeouts (Alice's lock expires after Bob's)
module sui_tunnel::example_atomic_swap;

use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::hash;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const ECommitmentMismatch: vector<u8> = b"The revealed value does not match the original commitment.";

#[error]
const EInvalidHash: vector<u8> = b"The hash value is invalid or has the wrong format.";

#[error]
const ETimeoutReached: vector<u8> = b"The timeout has already been reached.";

#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

#[error]
const ETimeoutNotReached: vector<u8> = b"The timeout has not been reached yet.";

#[error]
const EInvalidTimeout: vector<u8> = b"The timeout value is invalid.";

#[error]
const EInvalidDepositAmount: vector<u8> = b"The deposit amount is invalid.";

// ============================================
// CONSTANTS
// ============================================

/// Swap status: Locked
const STATUS_LOCKED: u8 = 0;

/// Swap status: Claimed
const STATUS_CLAIMED: u8 = 1;

/// Swap status: Refunded (expired)
const STATUS_REFUNDED: u8 = 2;

/// Minimum lock time: 1 hour
const MIN_LOCK_TIME_MS: u64 = 3600000;

/// Time buffer between swaps: 30 minutes
/// (Initiator's lock must last longer than responder's)
const SWAP_TIME_BUFFER_MS: u64 = 1800000;

// ============================================
// STRUCTS
// ============================================

/// A locked swap offer
public struct SwapLock<phantom T> has key, store {
    id: UID,
    /// Party who locked the funds
    locker: address,
    /// Party who can claim with the secret
    claimer: address,
    /// Locked funds
    funds: Balance<T>,
    /// Amount locked
    amount: u64,
    /// Hash of the secret (blake2b256)
    secret_hash: vector<u8>,
    /// Lock expiry time
    expires_at: u64,
    /// Current status
    status: u8,
    /// Creation timestamp
    created_at: u64,
}

/// Proof that a swap was completed
public struct SwapReceipt has copy, drop, store {
    /// Swap ID
    swap_id: vector<u8>,
    /// Who locked
    locker: address,
    /// Who claimed
    claimer: address,
    /// Amount swapped
    amount: u64,
    /// The revealed secret
    secret: vector<u8>,
    /// Completion timestamp
    completed_at: u64,
}

/// A swap pair linking two swap locks
public struct SwapPair has copy, drop, store {
    /// First swap lock ID (initiator's)
    initiator_swap_id: vector<u8>,
    /// Second swap lock ID (responder's)
    responder_swap_id: vector<u8>,
    /// Shared secret hash
    secret_hash: vector<u8>,
    /// Initiator address
    initiator: address,
    /// Responder address
    responder: address,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a swap lock is created
public struct SwapLocked has copy, drop {
    locker: address,
    claimer: address,
    amount: u64,
    expires_at: u64,
}

/// Emitted when a swap is claimed
public struct SwapClaimed has copy, drop {
    locker: address,
    claimer: address,
    amount: u64,
}

/// Emitted when a swap is refunded
public struct SwapRefunded has copy, drop {
    locker: address,
    amount: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS
// ============================================

public fun status_locked(): u8 { STATUS_LOCKED }

public fun status_claimed(): u8 { STATUS_CLAIMED }

public fun status_refunded(): u8 { STATUS_REFUNDED }

public fun min_lock_time_ms(): u64 { MIN_LOCK_TIME_MS }

public fun swap_time_buffer_ms(): u64 { SWAP_TIME_BUFFER_MS }

// ============================================
// SWAP LIFECYCLE
// ============================================

/// Create a new swap lock (initiator creates first)
public fun create_swap_lock<T>(
    claimer: address,
    payment: Coin<T>,
    secret_hash: vector<u8>,
    lock_duration_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SwapLock<T> {
    let locker = ctx.sender();
    assert!(locker != claimer, EInvalidParties);

    let amount = payment.value();
    assert!(amount > 0, EInvalidDepositAmount);
    assert!(secret_hash.length() == 32, EInvalidHash);
    assert!(lock_duration_ms >= MIN_LOCK_TIME_MS, EInvalidTimeout);

    let now = clock.timestamp_ms();

    event::emit(SwapLocked { locker, claimer, amount, expires_at: now + lock_duration_ms });

    SwapLock {
        id: object::new(ctx),
        locker,
        claimer,
        funds: payment.into_balance(),
        amount,
        secret_hash,
        expires_at: now + lock_duration_ms,
        status: STATUS_LOCKED,
        created_at: now,
    }
}

/// Create a matching swap lock (responder creates second)
/// Must use same secret_hash but shorter timeout
public fun create_matching_swap<T>(
    initiator_swap: &SwapLock<T>,
    payment: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): SwapLock<T> {
    let responder = ctx.sender();

    // Responder is the claimer of the initiator's swap
    assert!(responder == initiator_swap.claimer, ENotAuthorized);
    assert!(initiator_swap.status == STATUS_LOCKED, EInvalidState);

    let now = clock.timestamp_ms();

    // Ensure initiator's swap has enough time remaining
    let remaining = initiator_swap.expires_at - now;
    assert!(remaining > SWAP_TIME_BUFFER_MS + MIN_LOCK_TIME_MS, EInvalidTimeout);

    let amount = payment.value();
    assert!(amount > 0, EInvalidDepositAmount);

    // Responder's swap must expire before initiator's (minus buffer)
    let responder_expiry = initiator_swap.expires_at - SWAP_TIME_BUFFER_MS;

    event::emit(SwapLocked {
        locker: responder,
        claimer: initiator_swap.locker,
        amount,
        expires_at: responder_expiry,
    });

    SwapLock {
        id: object::new(ctx),
        locker: responder,
        claimer: initiator_swap.locker, // Initiator can claim this
        funds: payment.into_balance(),
        amount,
        secret_hash: initiator_swap.secret_hash, // Same hash
        expires_at: responder_expiry,
        status: STATUS_LOCKED,
        created_at: now,
    }
}

/// Claim funds by revealing the secret.
/// Funds are transferred directly to the claimer to prevent PTB interception.
public fun claim_swap<T>(
    swap: &mut SwapLock<T>,
    secret: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): SwapReceipt {
    assert!(ctx.sender() == swap.claimer, ENotAuthorized);
    assert!(swap.status == STATUS_LOCKED, EInvalidState);

    let now = clock.timestamp_ms();
    assert!(now < swap.expires_at, ETimeoutReached);

    // Verify secret
    let computed_hash = hash::blake2b256(&secret);
    assert!(computed_hash == swap.secret_hash, ECommitmentMismatch);

    swap.status = STATUS_CLAIMED;

    event::emit(SwapClaimed { locker: swap.locker, claimer: swap.claimer, amount: swap.amount });

    let funds_amount = swap.funds.value();
    let coins = coin::from_balance(swap.funds.split(funds_amount), ctx);
    transfer::public_transfer(coins, swap.claimer);

    SwapReceipt {
        swap_id: object::uid_to_bytes(&swap.id),
        locker: swap.locker,
        claimer: swap.claimer,
        amount: swap.amount,
        secret,
        completed_at: now,
    }
}

/// Claim using a receipt from another swap (reveals the secret).
/// Funds are transferred directly to the claimer to prevent PTB interception.
public fun claim_with_receipt<T>(
    swap: &mut SwapLock<T>,
    receipt: &SwapReceipt,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == swap.claimer, ENotAuthorized);
    assert!(swap.status == STATUS_LOCKED, EInvalidState);

    let now = clock.timestamp_ms();
    assert!(now < swap.expires_at, ETimeoutReached);

    // Verify secret from receipt matches our hash
    let computed_hash = hash::blake2b256(&receipt.secret);
    assert!(computed_hash == swap.secret_hash, ECommitmentMismatch);

    swap.status = STATUS_CLAIMED;

    event::emit(SwapClaimed { locker: swap.locker, claimer: swap.claimer, amount: swap.amount });

    let funds_amount = swap.funds.value();
    let coins = coin::from_balance(swap.funds.split(funds_amount), ctx);
    transfer::public_transfer(coins, swap.claimer);
}

/// Refund after expiry (locker gets funds back).
/// Funds are transferred directly to the locker to prevent PTB interception.
public fun refund_expired<T>(swap: &mut SwapLock<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(ctx.sender() == swap.locker, ENotAuthorized);
    assert!(swap.status == STATUS_LOCKED, EInvalidState);

    let now = clock.timestamp_ms();
    assert!(now >= swap.expires_at, ETimeoutNotReached);

    swap.status = STATUS_REFUNDED;

    event::emit(SwapRefunded { locker: swap.locker, amount: swap.amount });

    let funds_amount = swap.funds.value();
    let coins = coin::from_balance(swap.funds.split(funds_amount), ctx);
    transfer::public_transfer(coins, swap.locker);
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/// Generate a secret hash from a secret
public fun compute_secret_hash(secret: &vector<u8>): vector<u8> {
    hash::blake2b256(secret)
}

/// Create a swap pair record
public fun create_swap_pair<T>(
    initiator_swap: &SwapLock<T>,
    responder_swap: &SwapLock<T>,
): SwapPair {
    assert!(initiator_swap.secret_hash == responder_swap.secret_hash, ECommitmentMismatch);
    assert!(initiator_swap.claimer == responder_swap.locker, EInvalidParties);
    assert!(initiator_swap.locker == responder_swap.claimer, EInvalidParties);

    SwapPair {
        initiator_swap_id: object::uid_to_bytes(&initiator_swap.id),
        responder_swap_id: object::uid_to_bytes(&responder_swap.id),
        secret_hash: initiator_swap.secret_hash,
        initiator: initiator_swap.locker,
        responder: responder_swap.locker,
    }
}

/// Check if a swap is still claimable
public fun is_claimable<T>(swap: &SwapLock<T>, current_time_ms: u64): bool {
    swap.status == STATUS_LOCKED && current_time_ms < swap.expires_at
}

/// Check if a swap is expired and refundable
public fun is_refundable<T>(swap: &SwapLock<T>, current_time_ms: u64): bool {
    swap.status == STATUS_LOCKED && current_time_ms >= swap.expires_at
}

/// Time remaining until expiry (0 if expired)
public fun time_remaining<T>(swap: &SwapLock<T>, current_time_ms: u64): u64 {
    if (current_time_ms >= swap.expires_at) {
        0
    } else {
        swap.expires_at - current_time_ms
    }
}

// ============================================
// ACCESSORS
// ============================================

public fun swap_locker<T>(swap: &SwapLock<T>): address { swap.locker }

public fun swap_claimer<T>(swap: &SwapLock<T>): address { swap.claimer }

public fun swap_amount<T>(swap: &SwapLock<T>): u64 { swap.amount }

public fun swap_secret_hash<T>(swap: &SwapLock<T>): &vector<u8> { &swap.secret_hash }

public fun swap_expires_at<T>(swap: &SwapLock<T>): u64 { swap.expires_at }

public fun swap_status<T>(swap: &SwapLock<T>): u8 { swap.status }

public fun swap_created_at<T>(swap: &SwapLock<T>): u64 { swap.created_at }

// Receipt accessors
public fun receipt_swap_id(receipt: &SwapReceipt): &vector<u8> { &receipt.swap_id }

public fun receipt_secret(receipt: &SwapReceipt): &vector<u8> { &receipt.secret }

public fun receipt_locker(receipt: &SwapReceipt): address { receipt.locker }

public fun receipt_claimer(receipt: &SwapReceipt): address { receipt.claimer }

public fun receipt_amount(receipt: &SwapReceipt): u64 { receipt.amount }

// Pair accessors
public fun pair_initiator(pair: &SwapPair): address { pair.initiator }

public fun pair_responder(pair: &SwapPair): address { pair.responder }

public fun pair_secret_hash(pair: &SwapPair): &vector<u8> { &pair.secret_hash }
