#[test_only]
module sui_tunnel::example_dutch_auction_tests;

use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::example_dutch_auction as auction;

// ============================================
// SHARED TEST PARAMETERS
//
// Derived against the module's exact arithmetic in calculate_price:
//   start_time_ms = clock at creation (CREATE_AT = 1000)
//   end_time_ms   = start_time_ms + DURATION = 1000 + 600000 = 601000
//   start_price = 1000, end_price = 100, price_drop = 900
//   middle (elapsed 300000 of 600000): dropped = 900*300000/600000 = 450 -> 550
// ============================================

const SELLER: address = @0xA11CE;
const BUYER: address = @0xB0B;

const START_PRICE: u64 = 1000;
const END_PRICE: u64 = 100;
const DURATION: u64 = 600000; // == MIN_DURATION_MS
const CREATE_AT: u64 = 1000;
const END_AT: u64 = 601000; // CREATE_AT + DURATION
const MID_AT: u64 = 301000; // CREATE_AT + DURATION/2

// ============================================
// CONSTANT / GETTER SANITY (kept: these call the module)
// ============================================

#[test]
fun status_constants() {
    assert_eq!(auction::status_active(), 0);
    assert_eq!(auction::status_sold(), 1);
    assert_eq!(auction::status_expired(), 2);
    assert_eq!(auction::status_cancelled(), 3);
}

#[test]
fun min_duration() {
    // 10 minutes in ms
    assert_eq!(auction::min_duration_ms(), 600000);
}

// ============================================
// REAL LIFECYCLE: price curve via the module's OWN calculate_price
// ============================================

/// Create an auction and assert the module's calculate_price returns the
/// expected decayed price at start / middle / end (and clamps past the ends).
/// No formula is recomputed in the test — we call the real function.
#[test]
fun price_decays_start_middle_end() {
    let mut scenario = test_scenario::begin(SELLER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(CREATE_AT);

    let listing = auction::create_auction<SUI>(
        b"a rare item",
        b"item-1",
        START_PRICE,
        END_PRICE,
        DURATION,
        &clock,
        scenario.ctx(),
    );

    // Stored timing reflects the clock at creation.
    assert_eq!(auction::auction_start_time(&listing), CREATE_AT);
    assert_eq!(auction::auction_end_time(&listing), END_AT);
    assert_eq!(auction::auction_status(&listing), auction::status_active());

    // Clamp before/at start -> start price.
    assert_eq!(auction::calculate_price(&listing, 0), START_PRICE);
    assert_eq!(auction::calculate_price(&listing, CREATE_AT), START_PRICE);

    // Halfway through -> 550 (1000 - 450).
    assert_eq!(auction::calculate_price(&listing, MID_AT), 550);

    // At and beyond end -> end (reserve) price.
    assert_eq!(auction::calculate_price(&listing, END_AT), END_PRICE);
    assert_eq!(auction::calculate_price(&listing, END_AT + 999999), END_PRICE);

    // Linear drop rate: price_drop / duration = 900 / 600000 = 0 (integer).
    assert_eq!(auction::price_drop_rate(&listing), 0);

    // time_remaining and is_purchasable views.
    assert_eq!(auction::time_remaining(&listing, MID_AT), END_AT - MID_AT);
    assert_eq!(auction::time_remaining(&listing, END_AT), 0);
    assert!(auction::is_purchasable(&listing, MID_AT));
    assert!(!auction::is_purchasable(&listing, END_AT));

    destroy(listing);
    clock.destroy_for_testing();
    scenario.end();
}

// ============================================
// REAL LIFECYCLE: buy at current price (overpay -> refund) + seller withdraw
// ============================================

/// Full success path: seller creates, clock advances to the halfway point,
/// buyer pays MORE than the current price; assert the exact price charged,
/// the exact refunded change, status/winner/sale_price, then the seller
/// withdraws and receives the exact payout.
#[test]
fun buy_at_midpoint_refunds_change_and_seller_withdraws() {
    let mut scenario = test_scenario::begin(SELLER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(CREATE_AT);

    let mut listing = auction::create_auction<SUI>(
        b"a rare item",
        b"item-1",
        START_PRICE,
        END_PRICE,
        DURATION,
        &clock,
        scenario.ctx(),
    );

    // Advance to the midpoint -> the module charges 550.
    clock.set_for_testing(MID_AT);
    let expected_price = auction::calculate_price(&listing, MID_AT);
    assert_eq!(expected_price, 550);

    // Buyer pays 1000, overpaying by 450.
    scenario.next_tx(BUYER);
    let payment = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let (receipt, change) = auction::buy<SUI>(&mut listing, payment, &clock, scenario.ctx());

    // Exact price charged and exact change returned.
    assert_eq!(auction::purchase_price(&receipt), 550);
    assert_eq!(auction::purchase_buyer(&receipt), BUYER);
    assert_eq!(change.value(), 450);

    // Auction state after sale.
    assert_eq!(auction::auction_status(&listing), auction::status_sold());
    assert_eq!(auction::auction_sale_price(&listing), 550);
    assert_eq!(*auction::auction_winner(&listing).borrow(), BUYER);
    assert_eq!(*auction::purchase_item_id(&receipt), b"item-1");

    change.burn_for_testing();

    // Seller withdraws the collected payment; funds are public_transferred to seller.
    scenario.next_tx(SELLER);
    let settlement = auction::withdraw_payment<SUI>(&mut listing, scenario.ctx());
    assert_eq!(auction::settlement_amount(&settlement), 550);
    assert_eq!(auction::settlement_status(&settlement), auction::status_sold());
    assert_eq!(auction::settlement_seller(&settlement), SELLER);

    // Seller actually received a 550-value coin.
    scenario.next_tx(SELLER);
    let payout = scenario.take_from_address<coin::Coin<SUI>>(SELLER);
    assert_eq!(payout.value(), 550);
    payout.burn_for_testing();

    destroy(listing);
    clock.destroy_for_testing();
    scenario.end();
}

/// Success path for buy_exact: paying the EXACT current price yields a
/// zero-value change coin and marks the listing sold.
#[test]
fun buy_exact_at_start_no_change() {
    let mut scenario = test_scenario::begin(SELLER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(CREATE_AT);

    let mut listing = auction::create_auction<SUI>(
        b"a rare item",
        b"item-1",
        START_PRICE,
        END_PRICE,
        DURATION,
        &clock,
        scenario.ctx(),
    );

    // At creation time the price is the start price (1000).
    let price = auction::calculate_price(&listing, CREATE_AT);
    assert_eq!(price, START_PRICE);

    scenario.next_tx(BUYER);
    let payment = coin::mint_for_testing<SUI>(START_PRICE, scenario.ctx());
    let (receipt, change) = auction::buy_exact<SUI>(&mut listing, payment, &clock, scenario.ctx());

    assert_eq!(auction::purchase_price(&receipt), START_PRICE);
    assert_eq!(change.value(), 0);
    assert_eq!(auction::auction_status(&listing), auction::status_sold());
    assert_eq!(auction::auction_sale_price(&listing), START_PRICE);

    change.burn_for_testing();
    destroy(listing);
    clock.destroy_for_testing();
    scenario.end();
}

// ============================================
// REAL LIFECYCLE: expiry path
// ============================================

/// After the end time with no buyer, anyone can mark the listing expired.
#[test]
fun mark_expired_after_end_time() {
    let mut scenario = test_scenario::begin(SELLER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(CREATE_AT);

    let mut listing = auction::create_auction<SUI>(
        b"a rare item",
        b"item-1",
        START_PRICE,
        END_PRICE,
        DURATION,
        &clock,
        scenario.ctx(),
    );

    // Advance past the end and let a non-seller mark it expired.
    clock.set_for_testing(END_AT);
    scenario.next_tx(BUYER);
    let settlement = auction::mark_expired<SUI>(&mut listing, &clock, scenario.ctx());

    assert_eq!(auction::auction_status(&listing), auction::status_expired());
    assert_eq!(auction::settlement_status(&settlement), auction::status_expired());
    assert_eq!(auction::settlement_amount(&settlement), 0);

    destroy(listing);
    clock.destroy_for_testing();
    scenario.end();
}

// ============================================
// REAL LIFECYCLE: cancellation path
// ============================================

/// Seller cancels an active listing before any sale.
#[test]
fun seller_cancels_active_auction() {
    let mut scenario = test_scenario::begin(SELLER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(CREATE_AT);

    let mut listing = auction::create_auction<SUI>(
        b"a rare item",
        b"item-1",
        START_PRICE,
        END_PRICE,
        DURATION,
        &clock,
        scenario.ctx(),
    );

    let settlement = auction::cancel_auction<SUI>(&mut listing, scenario.ctx());
    assert_eq!(auction::auction_status(&listing), auction::status_cancelled());
    assert_eq!(auction::settlement_status(&settlement), auction::status_cancelled());
    assert_eq!(auction::settlement_amount(&settlement), 0);

    destroy(listing);
    clock.destroy_for_testing();
    scenario.end();
}

// ============================================
// NEGATIVE PATHS (#[expected_failure])
// ============================================

/// create_auction with start_price <= end_price aborts with invalid_deposit_amount (801).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_dutch_auction::EInvalidDepositAmount,
        location = sui_tunnel::example_dutch_auction,
    ),
]
fun create_rejects_non_descending_price() {
    let mut scenario = test_scenario::begin(SELLER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(CREATE_AT);

    // start_price (100) not strictly greater than end_price (100) -> invalid_deposit_amount
    let listing = auction::create_auction<SUI>(
        b"bad",
        b"item-1",
        100,
        100,
        DURATION,
        &clock,
        scenario.ctx(),
    );

    destroy(listing);
    clock.destroy_for_testing();
    scenario.end();
}

/// create_auction with a duration below MIN_DURATION_MS aborts with invalid_timeout (510).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_dutch_auction::EInvalidTimeout,
        location = sui_tunnel::example_dutch_auction,
    ),
]
fun create_rejects_short_duration() {
    let mut scenario = test_scenario::begin(SELLER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(CREATE_AT);

    // duration one ms below the minimum -> invalid_timeout
    let listing = auction::create_auction<SUI>(
        b"too short",
        b"item-1",
        START_PRICE,
        END_PRICE,
        DURATION - 1,
        &clock,
        scenario.ctx(),
    );

    destroy(listing);
    clock.destroy_for_testing();
    scenario.end();
}

/// The seller cannot buy their own listing -> invalid_parties (204).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_dutch_auction::EInvalidParties,
        location = sui_tunnel::example_dutch_auction,
    ),
]
fun seller_cannot_buy_own_auction() {
    let mut scenario = test_scenario::begin(SELLER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(CREATE_AT);

    let mut listing = auction::create_auction<SUI>(
        b"a rare item",
        b"item-1",
        START_PRICE,
        END_PRICE,
        DURATION,
        &clock,
        scenario.ctx(),
    );

    // Sender is still SELLER (== listing.seller) -> invalid_parties.
    let payment = coin::mint_for_testing<SUI>(START_PRICE, scenario.ctx());
    let (receipt, change) = auction::buy<SUI>(&mut listing, payment, &clock, scenario.ctx());

    destroy(receipt);
    change.burn_for_testing();
    destroy(listing);
    clock.destroy_for_testing();
    scenario.end();
}

/// Paying less than the current price aborts with insufficient_balance (800).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_dutch_auction::EInsufficientBalance,
        location = sui_tunnel::example_dutch_auction,
    ),
]
fun buy_underpay_fails() {
    let mut scenario = test_scenario::begin(SELLER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(CREATE_AT);

    let mut listing = auction::create_auction<SUI>(
        b"a rare item",
        b"item-1",
        START_PRICE,
        END_PRICE,
        DURATION,
        &clock,
        scenario.ctx(),
    );

    // At start the price is 1000; buyer offers only 999 -> insufficient_balance.
    scenario.next_tx(BUYER);
    let payment = coin::mint_for_testing<SUI>(START_PRICE - 1, scenario.ctx());
    let (receipt, change) = auction::buy<SUI>(&mut listing, payment, &clock, scenario.ctx());

    destroy(receipt);
    change.burn_for_testing();
    destroy(listing);
    clock.destroy_for_testing();
    scenario.end();
}

/// Buying after the listing end time aborts with timeout_reached (15).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_dutch_auction::ETimeoutReached,
        location = sui_tunnel::example_dutch_auction,
    ),
]
fun buy_after_end_fails() {
    let mut scenario = test_scenario::begin(SELLER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(CREATE_AT);

    let mut listing = auction::create_auction<SUI>(
        b"a rare item",
        b"item-1",
        START_PRICE,
        END_PRICE,
        DURATION,
        &clock,
        scenario.ctx(),
    );

    // now == end_time -> the `now < end_time_ms` assert fails with timeout_reached.
    clock.set_for_testing(END_AT);
    scenario.next_tx(BUYER);
    let payment = coin::mint_for_testing<SUI>(START_PRICE, scenario.ctx());
    let (receipt, change) = auction::buy<SUI>(&mut listing, payment, &clock, scenario.ctx());

    destroy(receipt);
    change.burn_for_testing();
    destroy(listing);
    clock.destroy_for_testing();
    scenario.end();
}

/// mark_expired before the end time aborts with timeout_not_reached (504).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_dutch_auction::ETimeoutNotReached,
        location = sui_tunnel::example_dutch_auction,
    ),
]
fun mark_expired_before_end_fails() {
    let mut scenario = test_scenario::begin(SELLER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(CREATE_AT);

    let mut listing = auction::create_auction<SUI>(
        b"a rare item",
        b"item-1",
        START_PRICE,
        END_PRICE,
        DURATION,
        &clock,
        scenario.ctx(),
    );

    // Still before end_time -> timeout_not_reached.
    let settlement = auction::mark_expired<SUI>(&mut listing, &clock, scenario.ctx());

    destroy(settlement);
    destroy(listing);
    clock.destroy_for_testing();
    scenario.end();
}

/// Only the seller may withdraw; a non-seller withdrawal aborts.
/// withdraw_payment first asserts sender == seller -> not_authorized (0)
/// (status is checked second, so authorization is the first failing check).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_dutch_auction::ENotAuthorized,
        location = sui_tunnel::example_dutch_auction,
    ),
]
fun non_seller_cannot_withdraw() {
    let mut scenario = test_scenario::begin(SELLER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(CREATE_AT);

    let mut listing = auction::create_auction<SUI>(
        b"a rare item",
        b"item-1",
        START_PRICE,
        END_PRICE,
        DURATION,
        &clock,
        scenario.ctx(),
    );

    // Buyer purchases so the listing is SOLD.
    scenario.next_tx(BUYER);
    let payment = coin::mint_for_testing<SUI>(START_PRICE, scenario.ctx());
    let (receipt, change) = auction::buy<SUI>(&mut listing, payment, &clock, scenario.ctx());
    destroy(receipt);
    change.burn_for_testing();

    // A non-seller (still BUYER) tries to withdraw -> not_authorized.
    let settlement = auction::withdraw_payment<SUI>(&mut listing, scenario.ctx());

    destroy(settlement);
    destroy(listing);
    clock.destroy_for_testing();
    scenario.end();
}
