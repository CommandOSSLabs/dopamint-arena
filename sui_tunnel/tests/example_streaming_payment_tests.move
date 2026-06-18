#[test_only]
module sui_tunnel::example_streaming_payment_tests;

use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::example_streaming_payment as stream;

// ============================================
// TEST CONSTANTS
// ============================================
//
// All expected values below are derived directly from the source arithmetic
// in `calculate_unlocked` / `withdraw` / `cancel_stream`, NOT recomputed with a
// parallel formula. With these parameters:
//
//   start = START_MS, end = START_MS + DURATION_MS, total = TOTAL
//   mid time = START_MS + DURATION_MS/2  -> unlocked = TOTAL * 1/2 = 500
//   (TOTAL as u128 * elapsed as u128) / duration as u128
//
const SENDER: address = @0xA11CE;
const RECIPIENT: address = @0xB0B;
const START_MS: u64 = 1_000;
const TOTAL: u64 = 1_000;

// DURATION_MS is the module's minimum (1 hour). end_time = START_MS + DURATION_MS.
fun duration_ms(): u64 { stream::min_duration_ms() }

fun end_ms(): u64 { START_MS + duration_ms() }

// Halfway through the stream window: elapsed == duration/2 -> 50% unlocked.
fun mid_ms(): u64 { START_MS + duration_ms() / 2 }

// ============================================
// PURE / CONSTANT GETTERS (call the module)
// ============================================

#[test]
fun status_constants() {
    assert_eq!(stream::status_active(), 0);
    assert_eq!(stream::status_completed(), 1);
    assert_eq!(stream::status_cancelled(), 2);
}

#[test]
fun min_duration() {
    // 1 hour in ms
    assert_eq!(stream::min_duration_ms(), 3_600_000);
}

// ============================================
// REAL VESTING CURVE (calls calculate_unlocked / available_balance)
// ============================================

/// Drives the module's OWN `calculate_unlocked` across the whole window and
/// asserts 0 at start, exactly 50% mid-stream, and full after end. No vesting
/// math is recomputed inline; we read the values the module returns.
#[test]
fun unlocked_curve_zero_partial_full() {
    let mut scenario = test_scenario::begin(SENDER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let s = stream::create_stream<SUI>(
        RECIPIENT,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // Stream metadata recorded as expected.
    assert_eq!(stream::stream_sender(&s), SENDER);
    assert_eq!(stream::stream_recipient(&s), RECIPIENT);
    assert_eq!(stream::stream_total_amount(&s), TOTAL);
    assert_eq!(stream::stream_withdrawn_amount(&s), 0);
    assert_eq!(stream::stream_start_time(&s), START_MS);
    assert_eq!(stream::stream_end_time(&s), end_ms());
    assert_eq!(stream::stream_status(&s), stream::status_active());
    assert!(stream::stream_is_active(&s));

    // At start (current_time <= start) -> 0 unlocked, full amount remaining.
    assert_eq!(stream::calculate_unlocked(&s, START_MS), 0);
    assert_eq!(stream::available_balance(&s, START_MS), 0);
    assert_eq!(stream::remaining_balance(&s, START_MS), TOTAL);
    // A time strictly before start also yields 0.
    assert_eq!(stream::calculate_unlocked(&s, 0), 0);

    // Mid-stream (50% elapsed): 1000 * 1_800_000 / 3_600_000 == 500.
    assert_eq!(stream::calculate_unlocked(&s, mid_ms()), 500);
    assert_eq!(stream::available_balance(&s, mid_ms()), 500);
    assert_eq!(stream::remaining_balance(&s, mid_ms()), 500);

    // At end (current_time >= end) -> full amount unlocked, nothing remaining.
    assert_eq!(stream::calculate_unlocked(&s, end_ms()), TOTAL);
    assert_eq!(stream::available_balance(&s, end_ms()), TOTAL);
    assert_eq!(stream::remaining_balance(&s, end_ms()), 0);
    // Well past end stays clamped at full.
    assert_eq!(stream::calculate_unlocked(&s, end_ms() + 5_000_000), TOTAL);

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}

// ============================================
// WITHDRAW SUCCESS PATH (calls withdraw, asserts Coin value)
// ============================================

/// Recipient withdraws mid-stream: the receipt and the directly-transferred
/// Coin must both equal the module-computed available amount (500), and the
/// stream's withdrawn_amount must advance to 500 while staying ACTIVE.
#[test]
fun withdraw_mid_stream_transfers_exact_vested_amount() {
    let mut scenario = test_scenario::begin(SENDER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = stream::create_stream<SUI>(
        RECIPIENT,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // Advance clock to the halfway point and withdraw as the recipient.
    c.set_for_testing(mid_ms());
    let expected = stream::available_balance(&s, mid_ms());
    assert_eq!(expected, 500);

    scenario.next_tx(RECIPIENT);
    let receipt = stream::withdraw<SUI>(&mut s, &c, scenario.ctx());

    // Receipt reflects the exact amount the module unlocked.
    assert_eq!(stream::withdrawal_amount(&receipt), 500);
    assert_eq!(stream::withdrawal_timestamp(&receipt), mid_ms());
    // Stream state advanced; still active (not yet fully withdrawn).
    assert_eq!(stream::stream_withdrawn_amount(&s), 500);
    assert_eq!(stream::stream_status(&s), stream::status_active());
    // Available drops to 0 right after withdrawing the unlocked slice.
    assert_eq!(stream::available_balance(&s, mid_ms()), 0);

    // The withdrawn funds were public_transfer-ed straight to the recipient.
    scenario.next_tx(RECIPIENT);
    let withdrawn = scenario.take_from_address<coin::Coin<SUI>>(RECIPIENT);
    assert_eq!(withdrawn.value(), 500);
    withdrawn.burn_for_testing();

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}

/// Withdrawing at/after end empties the stream: Coin value == TOTAL and the
/// stream transitions to COMPLETED.
#[test]
fun withdraw_after_end_completes_stream() {
    let mut scenario = test_scenario::begin(SENDER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = stream::create_stream<SUI>(
        RECIPIENT,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    c.set_for_testing(end_ms());
    scenario.next_tx(RECIPIENT);
    let receipt = stream::withdraw<SUI>(&mut s, &c, scenario.ctx());

    assert_eq!(stream::withdrawal_amount(&receipt), TOTAL);
    assert_eq!(stream::stream_withdrawn_amount(&s), TOTAL);
    assert_eq!(stream::stream_status(&s), stream::status_completed());

    scenario.next_tx(RECIPIENT);
    let withdrawn = scenario.take_from_address<coin::Coin<SUI>>(RECIPIENT);
    assert_eq!(withdrawn.value(), TOTAL);
    withdrawn.burn_for_testing();

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}

// ============================================
// CANCEL SUCCESS PATH (calls cancel_stream, asserts refund + earned split)
// ============================================

/// Sender cancels at the halfway point with no prior withdrawal: recipient is
/// paid the 500 it has earned, sender is refunded the unvested 500, stream goes
/// CANCELLED. Both Coins are asserted by value.
#[test]
fun cancel_mid_stream_refunds_unvested_remainder() {
    let mut scenario = test_scenario::begin(SENDER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = stream::create_stream<SUI>(
        RECIPIENT,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // Cancel halfway, as the sender (the default scenario sender).
    c.set_for_testing(mid_ms());
    let receipt = stream::cancel_stream<SUI>(&mut s, &c, scenario.ctx());

    // unlocked = 500, withdrawn = 0 -> recipient earns 500, refund = 1000 - 500.
    assert_eq!(stream::cancellation_refunded(&receipt), 500);
    assert_eq!(stream::cancellation_recipient_received(&receipt), 500);
    assert_eq!(stream::stream_status(&s), stream::status_cancelled());

    // Recipient received its earned 500; sender was refunded the unvested 500.
    scenario.next_tx(SENDER);
    let earned = scenario.take_from_address<coin::Coin<SUI>>(RECIPIENT);
    let refund = scenario.take_from_address<coin::Coin<SUI>>(SENDER);
    assert_eq!(earned.value(), 500);
    assert_eq!(refund.value(), 500);
    earned.burn_for_testing();
    refund.burn_for_testing();

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}

// ============================================
// NEGATIVE PATHS (#[expected_failure])
// ============================================

/// Withdrawing at the very start fails: nothing is unlocked yet, so
/// `available > 0` aborts with insufficient_balance() (== 800).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_streaming_payment::EInsufficientBalance,
        location = sui_tunnel::example_streaming_payment,
    ),
]
fun withdraw_before_anything_vested_aborts() {
    let mut scenario = test_scenario::begin(SENDER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = stream::create_stream<SUI>(
        RECIPIENT,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // Clock still at start -> unlocked == 0, available == 0 -> abort.
    // The abort happens inside withdraw(); the receipt (has drop) is never bound.
    scenario.next_tx(RECIPIENT);
    let _ = stream::withdraw<SUI>(&mut s, &c, scenario.ctx());

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}

/// Only the recipient may withdraw: the sender attempting a withdrawal aborts
/// with not_authorized() (== 0).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_streaming_payment::ENotAuthorized,
        location = sui_tunnel::example_streaming_payment,
    ),
]
fun non_recipient_withdraw_aborts() {
    let mut scenario = test_scenario::begin(SENDER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = stream::create_stream<SUI>(
        RECIPIENT,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // Sender (the default scenario sender) is not the recipient -> not_authorized.
    // The abort happens inside withdraw(); the receipt (has drop) is never bound.
    c.set_for_testing(mid_ms());
    let _ = stream::withdraw<SUI>(&mut s, &c, scenario.ctx());

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}

/// A stream with a duration below the module minimum (1 hour) is rejected at
/// creation with invalid_timeout() (== 510).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_streaming_payment::EInvalidTimeout,
        location = sui_tunnel::example_streaming_payment,
    ),
]
fun create_below_min_duration_aborts() {
    let mut scenario = test_scenario::begin(SENDER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let s = stream::create_stream<SUI>(
        RECIPIENT,
        payment,
        duration_ms() - 1,
        b"too short",
        &c,
        scenario.ctx(),
    );

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}
