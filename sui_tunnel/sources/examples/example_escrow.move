/// Example: Simple Escrow
///
/// A basic escrow service using tunnels for secure fund holding.
/// Demonstrates tunnel basics for conditional payments.
///
/// ## Flow:
/// 1. Buyer deposits funds into escrow
/// 2. Seller delivers goods/services
/// 3. Either: Buyer releases funds, or Dispute is raised
/// 4. Escrow settles based on outcome
///
/// ## Key Features:
/// - Conditional fund release
/// - Timeout-based auto-release
/// - Dispute support with referee
module sui_tunnel::example_escrow;

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
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

#[error]
const EDisputePeriodEnded: vector<u8> = b"The dispute period has already ended.";

#[error]
const ETimeoutNotReached: vector<u8> = b"The timeout has not been reached yet.";

#[error]
const EInvalidDepositAmount: vector<u8> = b"The deposit amount is invalid.";

// ============================================
// CONSTANTS
// ============================================

/// Escrow status: Created (waiting for seller).
/// Note: Currently escrows skip directly to STATUS_FUNDED on creation
/// since the buyer funds at creation time. This constant is part of the
/// status enum for completeness and future multi-step creation flows.
const STATUS_CREATED: u8 = 0;

/// Escrow status: Funded (both parties ready)
const STATUS_FUNDED: u8 = 1;

/// Escrow status: Delivered (seller claims delivery)
const STATUS_DELIVERED: u8 = 2;

/// Escrow status: Disputed (buyer disputes)
const STATUS_DISPUTED: u8 = 3;

/// Escrow status: Completed (funds released)
const STATUS_COMPLETED: u8 = 4;

/// Escrow status: Refunded (buyer refunded)
const STATUS_REFUNDED: u8 = 5;

/// Escrow status: Cancelled (before funding)
const STATUS_CANCELLED: u8 = 6;

/// Default dispute window: 7 days
const DEFAULT_DISPUTE_WINDOW_MS: u64 = 604800000;

/// Auto-release window: 30 days
const AUTO_RELEASE_WINDOW_MS: u64 = 2592000000;

// ============================================
// STRUCTS
// ============================================

/// An escrow agreement between buyer and seller
public struct Escrow<phantom T> has key, store {
    id: UID,
    /// Buyer (depositor)
    buyer: address,
    /// Seller (recipient)
    seller: address,
    /// Escrow amount
    amount: u64,
    /// Funds held in escrow
    funds: Balance<T>,
    /// Description/terms of the agreement
    description: vector<u8>,
    /// Hash of the terms (for verification)
    terms_hash: vector<u8>,
    /// Current status
    status: u8,
    /// Creation timestamp
    created_at: u64,
    /// Delivery timestamp (when seller marks delivered)
    delivered_at: u64,
    /// Dispute window (ms after delivery)
    dispute_window_ms: u64,
    /// Auto-release timestamp
    auto_release_at: u64,
    /// Dispute reason (if disputed)
    dispute_reason: vector<u8>,
}

/// Receipt for completed escrow
public struct EscrowReceipt has copy, drop, store {
    /// Escrow ID
    escrow_id: vector<u8>,
    /// Buyer
    buyer: address,
    /// Seller
    seller: address,
    /// Amount
    amount: u64,
    /// Final status
    status: u8,
    /// Completion timestamp
    completed_at: u64,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when an escrow is created
public struct EscrowCreated has copy, drop {
    buyer: address,
    seller: address,
    amount: u64,
    created_at: u64,
}

/// Emitted when seller marks delivery
public struct EscrowDelivered has copy, drop {
    buyer: address,
    seller: address,
    delivered_at: u64,
}

/// Emitted when escrow is completed
public struct EscrowCompleted has copy, drop {
    buyer: address,
    seller: address,
    amount: u64,
}

/// Emitted when a dispute is raised
public struct EscrowDisputed has copy, drop {
    buyer: address,
    seller: address,
    reason: vector<u8>,
}

/// Emitted when buyer is refunded
public struct EscrowRefunded has copy, drop {
    buyer: address,
    seller: address,
    amount: u64,
}

/// Emitted when escrow is cancelled
public struct EscrowCancelled has copy, drop {
    buyer: address,
    amount: u64,
}

/// Emitted when escrow funds are force-released
public struct EscrowForceReleased has copy, drop {
    buyer: address,
    seller: address,
    amount: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS
// ============================================

public fun status_created(): u8 { STATUS_CREATED }

public fun status_funded(): u8 { STATUS_FUNDED }

public fun status_delivered(): u8 { STATUS_DELIVERED }

public fun status_disputed(): u8 { STATUS_DISPUTED }

public fun status_completed(): u8 { STATUS_COMPLETED }

public fun status_refunded(): u8 { STATUS_REFUNDED }

public fun status_cancelled(): u8 { STATUS_CANCELLED }

public fun default_dispute_window_ms(): u64 { DEFAULT_DISPUTE_WINDOW_MS }

public fun auto_release_window_ms(): u64 { AUTO_RELEASE_WINDOW_MS }

// ============================================
// ESCROW LIFECYCLE
// ============================================

/// Creates a new escrow agreement
public fun create_escrow<T>(
    seller: address,
    description: vector<u8>,
    payment: Coin<T>,
    dispute_window_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Escrow<T> {
    let buyer = ctx.sender();
    assert!(buyer != seller, EInvalidParties);

    let amount = payment.value();
    assert!(amount > 0, EInvalidDepositAmount);

    let now = clock.timestamp_ms();

    let window = if (dispute_window_ms > 0) {
        dispute_window_ms
    } else {
        DEFAULT_DISPUTE_WINDOW_MS
    };

    let escrow = Escrow {
        id: object::new(ctx),
        buyer,
        seller,
        amount,
        funds: payment.into_balance(),
        description,
        terms_hash: hash::blake2b256(&description),
        status: STATUS_FUNDED,
        created_at: now,
        delivered_at: 0,
        dispute_window_ms: window,
        auto_release_at: now + AUTO_RELEASE_WINDOW_MS,
        dispute_reason: vector[],
    };

    event::emit(EscrowCreated { buyer, seller, amount, created_at: now });

    escrow
}

/// Seller marks the goods/services as delivered
public fun mark_delivered<T>(escrow: &mut Escrow<T>, clock: &Clock, ctx: &TxContext) {
    assert!(ctx.sender() == escrow.seller, ENotAuthorized);
    assert!(escrow.status == STATUS_FUNDED, EInvalidState);

    let now = clock.timestamp_ms();

    escrow.status = STATUS_DELIVERED;
    escrow.delivered_at = now;

    event::emit(EscrowDelivered { buyer: escrow.buyer, seller: escrow.seller, delivered_at: now });
}

/// Buyer confirms receipt and releases funds to seller
public fun confirm_and_release<T>(
    escrow: &mut Escrow<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): EscrowReceipt {
    assert!(ctx.sender() == escrow.buyer, ENotAuthorized);
    assert!(escrow.status == STATUS_FUNDED || escrow.status == STATUS_DELIVERED, EInvalidState);

    escrow.status = STATUS_COMPLETED;

    let funds_amount = escrow.funds.value();
    let funds = coin::from_balance(escrow.funds.split(funds_amount), ctx);

    let receipt = EscrowReceipt {
        escrow_id: escrow.id.to_bytes(),
        buyer: escrow.buyer,
        seller: escrow.seller,
        amount: escrow.amount,
        status: STATUS_COMPLETED,
        completed_at: clock.timestamp_ms(),
    };

    event::emit(EscrowCompleted {
        buyer: escrow.buyer,
        seller: escrow.seller,
        amount: escrow.amount,
    });

    // Transfer funds directly to seller to prevent buyer from keeping them
    transfer::public_transfer(funds, escrow.seller);

    receipt
}

/// Buyer raises a dispute
public fun raise_dispute<T>(
    escrow: &mut Escrow<T>,
    reason: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == escrow.buyer, ENotAuthorized);
    assert!(escrow.status == STATUS_DELIVERED, EInvalidState);

    let now = clock.timestamp_ms();

    // Must be within dispute window
    assert!(now <= escrow.delivered_at + escrow.dispute_window_ms, EDisputePeriodEnded);

    escrow.status = STATUS_DISPUTED;
    escrow.dispute_reason = reason;

    event::emit(EscrowDisputed { buyer: escrow.buyer, seller: escrow.seller, reason });
}

/// Auto-release after dispute window passes (seller can claim).
/// Funds are transferred directly to the seller to prevent PTB interception.
public fun auto_release<T>(escrow: &mut Escrow<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(ctx.sender() == escrow.seller, ENotAuthorized);
    assert!(escrow.status == STATUS_DELIVERED, EInvalidState);

    let now = clock.timestamp_ms();

    // Dispute window must have passed
    assert!(now > escrow.delivered_at + escrow.dispute_window_ms, ETimeoutNotReached);

    escrow.status = STATUS_COMPLETED;

    event::emit(EscrowCompleted {
        buyer: escrow.buyer,
        seller: escrow.seller,
        amount: escrow.amount,
    });

    let funds_amount = escrow.funds.value();
    let coins = coin::from_balance(escrow.funds.split(funds_amount), ctx);
    transfer::public_transfer(coins, escrow.seller);
}

/// Force release after auto-release window (seller claims funds).
/// Only the seller can call this, as the intent is to release funds
/// to the seller when the buyer is non-responsive after 30 days.
/// Funds are transferred directly to the seller to prevent PTB interception.
public fun force_release<T>(escrow: &mut Escrow<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(ctx.sender() == escrow.seller, ENotAuthorized);
    assert!(escrow.status == STATUS_FUNDED || escrow.status == STATUS_DELIVERED, EInvalidState);

    let now = clock.timestamp_ms();

    // Auto-release window must have passed
    assert!(now > escrow.auto_release_at, ETimeoutNotReached);

    // Release to seller by default
    escrow.status = STATUS_COMPLETED;

    event::emit(EscrowForceReleased {
        buyer: escrow.buyer,
        seller: escrow.seller,
        amount: escrow.amount,
    });

    let funds_amount = escrow.funds.value();
    let coins = coin::from_balance(escrow.funds.split(funds_amount), ctx);
    transfer::public_transfer(coins, escrow.seller);
}

/// Refund buyer (seller agrees or dispute resolved in buyer's favor)
public fun refund_buyer<T>(escrow: &mut Escrow<T>, ctx: &mut TxContext) {
    // Only seller can voluntarily refund, or after dispute resolution
    assert!(ctx.sender() == escrow.seller, ENotAuthorized);
    assert!(
        escrow.status == STATUS_FUNDED ||
        escrow.status == STATUS_DELIVERED ||
        escrow.status == STATUS_DISPUTED,
        EInvalidState,
    );

    escrow.status = STATUS_REFUNDED;

    event::emit(EscrowRefunded {
        buyer: escrow.buyer,
        seller: escrow.seller,
        amount: escrow.amount,
    });

    let funds_amount = escrow.funds.value();
    let refund = coin::from_balance(escrow.funds.split(funds_amount), ctx);
    transfer::public_transfer(refund, escrow.buyer);
}

/// Cancel escrow before delivery (buyer gets refund).
/// Funds are transferred directly to the buyer to prevent PTB interception.
public fun cancel_escrow<T>(escrow: &mut Escrow<T>, ctx: &mut TxContext) {
    assert!(ctx.sender() == escrow.buyer, ENotAuthorized);
    assert!(escrow.status == STATUS_FUNDED, EInvalidState);

    escrow.status = STATUS_CANCELLED;

    event::emit(EscrowCancelled { buyer: escrow.buyer, amount: escrow.amount });

    let funds_amount = escrow.funds.value();
    let coins = coin::from_balance(escrow.funds.split(funds_amount), ctx);
    transfer::public_transfer(coins, escrow.buyer);
}

// ============================================
// ACCESSORS
// ============================================

public fun escrow_buyer<T>(escrow: &Escrow<T>): address { escrow.buyer }

public fun escrow_seller<T>(escrow: &Escrow<T>): address { escrow.seller }

public fun escrow_amount<T>(escrow: &Escrow<T>): u64 { escrow.amount }

public fun escrow_status<T>(escrow: &Escrow<T>): u8 { escrow.status }

public fun escrow_description<T>(escrow: &Escrow<T>): &vector<u8> { &escrow.description }

public fun escrow_terms_hash<T>(escrow: &Escrow<T>): &vector<u8> { &escrow.terms_hash }

public fun escrow_created_at<T>(escrow: &Escrow<T>): u64 { escrow.created_at }

public fun escrow_delivered_at<T>(escrow: &Escrow<T>): u64 { escrow.delivered_at }

public fun escrow_dispute_reason<T>(escrow: &Escrow<T>): &vector<u8> { &escrow.dispute_reason }

public fun escrow_is_active<T>(escrow: &Escrow<T>): bool {
    escrow.status == STATUS_FUNDED ||
    escrow.status == STATUS_DELIVERED ||
    escrow.status == STATUS_DISPUTED
}

// Receipt accessors
public fun receipt_escrow_id(receipt: &EscrowReceipt): &vector<u8> { &receipt.escrow_id }

public fun receipt_buyer(receipt: &EscrowReceipt): address { receipt.buyer }

public fun receipt_seller(receipt: &EscrowReceipt): address { receipt.seller }

public fun receipt_amount(receipt: &EscrowReceipt): u64 { receipt.amount }

public fun receipt_status(receipt: &EscrowReceipt): u8 { receipt.status }

public fun receipt_completed_at(receipt: &EscrowReceipt): u64 { receipt.completed_at }
