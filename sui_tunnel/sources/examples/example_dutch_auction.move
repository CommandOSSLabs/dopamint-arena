/// Example: Dutch Auction
///
/// A descending price auction where price drops over time.
/// First bidder to accept the current price wins.
///
/// ## Flow:
/// 1. Seller creates auction with start price, end price, duration
/// 2. Price decreases linearly from start to end
/// 3. Any buyer can accept current price
/// 4. First accepted bid wins and receives the item
///
/// ## Key Features:
/// - Descending price mechanism
/// - Immediate settlement on acceptance
/// - Fair price discovery
/// - Timeout with reserve price protection
module sui_tunnel::example_dutch_auction;

use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const ETimeoutReached: vector<u8> = b"The timeout has already been reached.";

#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

#[error]
const ETimeoutNotReached: vector<u8> = b"The timeout has not been reached yet.";

#[error]
const EInvalidTimeout: vector<u8> = b"The timeout value is invalid.";

#[error]
const EInsufficientBalance: vector<u8> = b"Insufficient balance for this operation.";

#[error]
const EInvalidDepositAmount: vector<u8> = b"The deposit amount is invalid.";

#[error]
const EBalanceMismatch: vector<u8> = b"The balance does not match the expected amount after the operation.";

// ============================================
// CONSTANTS
// ============================================

/// Auction status: Active
const STATUS_ACTIVE: u8 = 0;

/// Auction status: Sold
const STATUS_SOLD: u8 = 1;

/// Auction status: Expired (no buyer)
const STATUS_EXPIRED: u8 = 2;

/// Auction status: Cancelled
const STATUS_CANCELLED: u8 = 3;

/// Minimum auction duration: 10 minutes
const MIN_DURATION_MS: u64 = 600000;

// ============================================
// STRUCTS
// ============================================

/// A Dutch auction listing
public struct DutchAuction<phantom T> has key, store {
    id: UID,
    /// Seller address
    seller: address,
    /// Item description
    description: vector<u8>,
    /// Item metadata (could be NFT ID, etc.)
    item_id: vector<u8>,
    /// Starting (maximum) price
    start_price: u64,
    /// Ending (minimum/reserve) price
    end_price: u64,
    /// Auction start time
    start_time_ms: u64,
    /// Auction end time
    end_time_ms: u64,
    /// Current status
    status: u8,
    /// Winner (if sold)
    winner: Option<address>,
    /// Final sale price
    sale_price: u64,
    /// Collected payment
    payment: Balance<T>,
}

/// Receipt for a successful purchase
public struct PurchaseReceipt has copy, drop, store {
    /// Auction ID
    auction_id: vector<u8>,
    /// Buyer address
    buyer: address,
    /// Item ID
    item_id: vector<u8>,
    /// Price paid
    price: u64,
    /// Purchase timestamp
    purchased_at: u64,
}

/// Receipt for auction settlement
public struct SettlementReceipt has copy, drop, store {
    /// Auction ID
    auction_id: vector<u8>,
    /// Seller address
    seller: address,
    /// Final status
    status: u8,
    /// Amount received (0 if not sold)
    amount: u64,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when an auction is created
public struct AuctionCreated has copy, drop {
    seller: address,
    start_price: u64,
    end_price: u64,
    start_time_ms: u64,
    end_time_ms: u64,
}

/// Emitted when a bid (purchase) is made
public struct AuctionBid has copy, drop {
    buyer: address,
    seller: address,
    price: u64,
}

/// Emitted when auction is settled (sale complete, payment withdrawn)
public struct AuctionSettled has copy, drop {
    seller: address,
    amount: u64,
}

/// Emitted when auction expires with no buyer
public struct AuctionExpired has copy, drop {
    seller: address,
}

/// Emitted when an auction is cancelled
public struct AuctionCancelled has copy, drop {
    seller: address,
}

// ============================================
// PUBLIC GETTER FUNCTIONS
// ============================================

public fun status_active(): u8 { STATUS_ACTIVE }

public fun status_sold(): u8 { STATUS_SOLD }

public fun status_expired(): u8 { STATUS_EXPIRED }

public fun status_cancelled(): u8 { STATUS_CANCELLED }

public fun min_duration_ms(): u64 { MIN_DURATION_MS }

// ============================================
// AUCTION LIFECYCLE
// ============================================

/// Create a new Dutch auction
public fun create_auction<T>(
    description: vector<u8>,
    item_id: vector<u8>,
    start_price: u64,
    end_price: u64,
    duration_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): DutchAuction<T> {
    let seller = ctx.sender();

    assert!(start_price > end_price, EInvalidDepositAmount);
    assert!(end_price > 0, EInvalidDepositAmount);
    assert!(duration_ms >= MIN_DURATION_MS, EInvalidTimeout);

    let now = clock.timestamp_ms();

    event::emit(AuctionCreated {
        seller,
        start_price,
        end_price,
        start_time_ms: now,
        end_time_ms: now + duration_ms,
    });

    DutchAuction {
        id: object::new(ctx),
        seller,
        description,
        item_id,
        start_price,
        end_price,
        start_time_ms: now,
        end_time_ms: now + duration_ms,
        status: STATUS_ACTIVE,
        winner: option::none(),
        sale_price: 0,
        payment: balance::zero(),
    }
}

/// Buy at the current price, returning change to the buyer
public fun buy<T>(
    auction: &mut DutchAuction<T>,
    payment: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): (PurchaseReceipt, Coin<T>) {
    let buyer = ctx.sender();
    assert!(buyer != auction.seller, EInvalidParties);
    assert!(auction.status == STATUS_ACTIVE, EInvalidState);

    let now = clock.timestamp_ms();
    assert!(now < auction.end_time_ms, ETimeoutReached);

    let current_price = calculate_price(auction, now);
    let payment_amount = payment.value();
    assert!(payment_amount >= current_price, EInsufficientBalance);

    // Split exact price and return change
    let mut payment_balance = payment.into_balance();
    let exact_payment = payment_balance.split(current_price);
    let change = coin::from_balance(payment_balance, ctx);

    auction.payment.join(exact_payment);
    auction.status = STATUS_SOLD;
    auction.winner = option::some(buyer);
    auction.sale_price = current_price;

    event::emit(AuctionBid { buyer, seller: auction.seller, price: current_price });

    let receipt = PurchaseReceipt {
        auction_id: object::uid_to_bytes(&auction.id),
        buyer,
        item_id: auction.item_id,
        price: current_price,
        purchased_at: now,
    };

    (receipt, change)
}

/// Buy at exact current price (no overpayment)
public fun buy_exact<T>(
    auction: &mut DutchAuction<T>,
    payment: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): (PurchaseReceipt, Coin<T>) {
    let buyer = ctx.sender();
    assert!(buyer != auction.seller, EInvalidParties);
    assert!(auction.status == STATUS_ACTIVE, EInvalidState);

    let now = clock.timestamp_ms();
    assert!(now < auction.end_time_ms, ETimeoutReached);

    let current_price = calculate_price(auction, now);
    let payment_amount = payment.value();
    assert!(payment_amount == current_price, EBalanceMismatch);

    // Take entire coin (must be exact amount)
    auction.payment.join(payment.into_balance());
    let change = coin::zero(ctx);
    auction.status = STATUS_SOLD;
    auction.winner = option::some(buyer);
    auction.sale_price = current_price;

    event::emit(AuctionBid { buyer, seller: auction.seller, price: current_price });

    let receipt = PurchaseReceipt {
        auction_id: object::uid_to_bytes(&auction.id),
        buyer,
        item_id: auction.item_id,
        price: current_price,
        purchased_at: now,
    };

    (receipt, change)
}

/// Seller withdraws payment after sale.
/// Funds are transferred directly to the seller to prevent PTB interception.
public fun withdraw_payment<T>(
    auction: &mut DutchAuction<T>,
    ctx: &mut TxContext,
): SettlementReceipt {
    assert!(ctx.sender() == auction.seller, ENotAuthorized);
    assert!(auction.status == STATUS_SOLD, EInvalidState);

    let amount = auction.payment.value();
    let coins = coin::from_balance(auction.payment.split(amount), ctx);
    transfer::public_transfer(coins, auction.seller);

    event::emit(AuctionSettled { seller: auction.seller, amount });

    SettlementReceipt {
        auction_id: object::uid_to_bytes(&auction.id),
        seller: auction.seller,
        status: STATUS_SOLD,
        amount,
    }
}

/// Mark auction as expired (no sale).
/// Anyone can call this after the auction end time, preventing the auction
/// from being stuck if the seller disappears.
public fun mark_expired<T>(
    auction: &mut DutchAuction<T>,
    clock: &Clock,
    _ctx: &TxContext,
): SettlementReceipt {
    assert!(auction.status == STATUS_ACTIVE, EInvalidState);

    let now = clock.timestamp_ms();
    assert!(now >= auction.end_time_ms, ETimeoutNotReached);

    auction.status = STATUS_EXPIRED;

    event::emit(AuctionExpired { seller: auction.seller });

    SettlementReceipt {
        auction_id: object::uid_to_bytes(&auction.id),
        seller: auction.seller,
        status: STATUS_EXPIRED,
        amount: 0,
    }
}

/// Cancel auction before any sale
public fun cancel_auction<T>(auction: &mut DutchAuction<T>, ctx: &TxContext): SettlementReceipt {
    assert!(ctx.sender() == auction.seller, ENotAuthorized);
    assert!(auction.status == STATUS_ACTIVE, EInvalidState);

    auction.status = STATUS_CANCELLED;

    event::emit(AuctionCancelled { seller: auction.seller });

    SettlementReceipt {
        auction_id: object::uid_to_bytes(&auction.id),
        seller: auction.seller,
        status: STATUS_CANCELLED,
        amount: 0,
    }
}

// ============================================
// VIEW FUNCTIONS
// ============================================

/// Calculate current price at a given time
public fun calculate_price<T>(auction: &DutchAuction<T>, current_time_ms: u64): u64 {
    if (current_time_ms <= auction.start_time_ms) {
        auction.start_price
    } else if (current_time_ms >= auction.end_time_ms) {
        auction.end_price
    } else {
        let elapsed = current_time_ms - auction.start_time_ms;
        let duration = auction.end_time_ms - auction.start_time_ms;
        let price_drop = auction.start_price - auction.end_price;
        let dropped = (((price_drop as u128) * (elapsed as u128)) / (duration as u128) as u64);
        auction.start_price - dropped
    }
}

/// Get time remaining in the auction
public fun time_remaining<T>(auction: &DutchAuction<T>, current_time_ms: u64): u64 {
    if (current_time_ms >= auction.end_time_ms) {
        0
    } else {
        auction.end_time_ms - current_time_ms
    }
}

/// Get price drop rate per millisecond
public fun price_drop_rate<T>(auction: &DutchAuction<T>): u64 {
    let duration = auction.end_time_ms - auction.start_time_ms;
    let price_drop = auction.start_price - auction.end_price;
    price_drop / duration
}

/// Check if auction is still active for purchase
public fun is_purchasable<T>(auction: &DutchAuction<T>, current_time_ms: u64): bool {
    auction.status == STATUS_ACTIVE && current_time_ms < auction.end_time_ms
}

// ============================================
// ACCESSORS
// ============================================

public fun auction_seller<T>(auction: &DutchAuction<T>): address { auction.seller }

public fun auction_description<T>(auction: &DutchAuction<T>): &vector<u8> { &auction.description }

public fun auction_item_id<T>(auction: &DutchAuction<T>): &vector<u8> { &auction.item_id }

public fun auction_start_price<T>(auction: &DutchAuction<T>): u64 { auction.start_price }

public fun auction_end_price<T>(auction: &DutchAuction<T>): u64 { auction.end_price }

public fun auction_start_time<T>(auction: &DutchAuction<T>): u64 { auction.start_time_ms }

public fun auction_end_time<T>(auction: &DutchAuction<T>): u64 { auction.end_time_ms }

public fun auction_status<T>(auction: &DutchAuction<T>): u8 { auction.status }

public fun auction_winner<T>(auction: &DutchAuction<T>): Option<address> { auction.winner }

public fun auction_sale_price<T>(auction: &DutchAuction<T>): u64 { auction.sale_price }

// Receipt accessors
public fun purchase_auction_id(receipt: &PurchaseReceipt): &vector<u8> { &receipt.auction_id }

public fun purchase_buyer(receipt: &PurchaseReceipt): address { receipt.buyer }

public fun purchase_item_id(receipt: &PurchaseReceipt): &vector<u8> { &receipt.item_id }

public fun purchase_price(receipt: &PurchaseReceipt): u64 { receipt.price }

public fun settlement_auction_id(receipt: &SettlementReceipt): &vector<u8> { &receipt.auction_id }

public fun settlement_seller(receipt: &SettlementReceipt): address { receipt.seller }

public fun settlement_status(receipt: &SettlementReceipt): u8 { receipt.status }

public fun settlement_amount(receipt: &SettlementReceipt): u64 { receipt.amount }
