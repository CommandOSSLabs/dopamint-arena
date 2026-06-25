#[test_only]
module sui_tunnel::example_streaming_payroll_tests;

use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::example_streaming_payroll as salary;

// ============================================
// TEST CONSTANTS
// ============================================
//
// All expected values below are derived directly from the source arithmetic
// in `calculate_unlocked` / `claim_salary` / `cancel_salary`, NOT recomputed
// with a parallel formula. With these parameters:
//
//   start = START_MS, end = START_MS + DURATION_MS, total = TOTAL
//   mid time = START_MS + DURATION_MS/2  -> unlocked = TOTAL * 1/2 = 500
//   (TOTAL as u128 * elapsed as u128) / duration as u128
//
const EMPLOYER: address = @0xA11CE;
const EMPLOYEE: address = @0xB0B;
const START_MS: u64 = 1_000;
const TOTAL: u64 = 1_000;

// DURATION_MS is the module's minimum (1 hour). end_time = START_MS + DURATION_MS.
fun duration_ms(): u64 { salary::min_duration_ms() }

fun end_ms(): u64 { START_MS + duration_ms() }

// Halfway through the pay period: elapsed == duration/2 -> 50% vested.
fun mid_ms(): u64 { START_MS + duration_ms() / 2 }

// ============================================
// PURE / CONSTANT GETTERS (call the module)
// ============================================

#[test]
fun status_constants() {
    assert_eq!(salary::status_active(), 0);
    assert_eq!(salary::status_completed(), 1);
    assert_eq!(salary::status_cancelled(), 2);
}

#[test]
fun min_duration() {
    // 1 hour in ms
    assert_eq!(salary::min_duration_ms(), 3_600_000);
}

// ============================================
// REAL VESTING CURVE (calls calculate_unlocked / available_balance)
// ============================================

/// Drives the module's OWN `calculate_unlocked` across the whole window and
/// asserts 0 at start, exactly 50% mid-stream, and full after end. No vesting
/// math is recomputed inline; we read the values the module returns.
#[test]
fun unlocked_curve_zero_partial_full() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // Salary metadata recorded as expected.
    assert_eq!(salary::salary_employer(&s), EMPLOYER);
    assert_eq!(salary::salary_employee(&s), EMPLOYEE);
    assert_eq!(salary::salary_total_amount(&s), TOTAL);
    assert_eq!(salary::salary_withdrawn_amount(&s), 0);
    assert_eq!(salary::salary_start_time(&s), START_MS);
    assert_eq!(salary::salary_end_time(&s), end_ms());
    assert_eq!(salary::salary_status(&s), salary::status_active());
    assert!(salary::salary_is_active(&s));

    // At start (current_time <= start) -> 0 vested, full amount remaining.
    assert_eq!(salary::calculate_unlocked(&s, START_MS), 0);
    assert_eq!(salary::available_balance(&s, START_MS), 0);
    assert_eq!(salary::remaining_balance(&s, START_MS), TOTAL);
    // A time strictly before start also yields 0.
    assert_eq!(salary::calculate_unlocked(&s, 0), 0);

    // Mid-stream (50% elapsed): 1000 * 1_800_000 / 3_600_000 == 500.
    assert_eq!(salary::calculate_unlocked(&s, mid_ms()), 500);
    assert_eq!(salary::available_balance(&s, mid_ms()), 500);
    assert_eq!(salary::remaining_balance(&s, mid_ms()), 500);

    // At end (current_time >= end) -> full amount vested, nothing remaining.
    assert_eq!(salary::calculate_unlocked(&s, end_ms()), TOTAL);
    assert_eq!(salary::available_balance(&s, end_ms()), TOTAL);
    assert_eq!(salary::remaining_balance(&s, end_ms()), 0);
    // Well past end stays clamped at full.
    assert_eq!(salary::calculate_unlocked(&s, end_ms() + 5_000_000), TOTAL);

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}

/// `rate_per_second` reports total / (duration in seconds). With a 1-hour pay
/// period (3600 s) and TOTAL == 1000, the per-second rate is 1000 / 3600 == 0.
#[test]
fun rate_per_second_matches_duration_seconds() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    let duration_seconds = duration_ms() / 1000;
    assert_eq!(salary::rate_per_second(&s), TOTAL / duration_seconds);

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}

// ============================================
// CLAIM SUCCESS PATH (calls claim_salary, asserts Coin value)
// ============================================

/// Employee claims mid-stream: the receipt and the directly-transferred Coin
/// must both equal the module-computed available amount (500), and the
/// stream's withdrawn_amount must advance to 500 while staying ACTIVE.
#[test]
fun claim_mid_stream_transfers_exact_vested_amount() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // Advance clock to the halfway point and claim as the employee.
    c.set_for_testing(mid_ms());
    let expected = salary::available_balance(&s, mid_ms());
    assert_eq!(expected, 500);

    scenario.next_tx(EMPLOYEE);
    let receipt = salary::claim_salary<SUI>(&mut s, &c, scenario.ctx());

    // Receipt reflects the exact amount the module vested.
    assert_eq!(salary::withdrawal_amount(&receipt), 500);
    assert_eq!(salary::withdrawal_timestamp(&receipt), mid_ms());
    // Salary state advanced; still active (not yet fully claimed).
    assert_eq!(salary::salary_withdrawn_amount(&s), 500);
    assert_eq!(salary::salary_status(&s), salary::status_active());
    // Available drops to 0 right after claiming the vested slice.
    assert_eq!(salary::available_balance(&s, mid_ms()), 0);

    // The claimed funds were public_transfer-ed straight to the employee.
    scenario.next_tx(EMPLOYEE);
    let withdrawn = scenario.take_from_address<coin::Coin<SUI>>(EMPLOYEE);
    assert_eq!(withdrawn.value(), 500);
    withdrawn.burn_for_testing();

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}

/// Claiming at/after end empties the stream: Coin value == TOTAL and the
/// stream transitions to COMPLETED.
#[test]
fun claim_after_end_completes_stream() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    c.set_for_testing(end_ms());
    scenario.next_tx(EMPLOYEE);
    let receipt = salary::claim_salary<SUI>(&mut s, &c, scenario.ctx());

    assert_eq!(salary::withdrawal_amount(&receipt), TOTAL);
    assert_eq!(salary::salary_withdrawn_amount(&s), TOTAL);
    assert_eq!(salary::salary_status(&s), salary::status_completed());

    scenario.next_tx(EMPLOYEE);
    let withdrawn = scenario.take_from_address<coin::Coin<SUI>>(EMPLOYEE);
    assert_eq!(withdrawn.value(), TOTAL);
    withdrawn.burn_for_testing();

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}

// ============================================
// CANCEL SUCCESS PATH (calls cancel_salary, asserts refund + earned split)
// ============================================

/// Employer cancels at the halfway point with no prior claim: employee is paid
/// the 500 it has earned, employer is refunded the unvested 500, stream goes
/// CANCELLED. Both Coins are asserted by value.
#[test]
fun cancel_mid_stream_refunds_unvested_remainder() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // Cancel halfway, as the employer (the default scenario sender).
    c.set_for_testing(mid_ms());
    let receipt = salary::cancel_salary<SUI>(&mut s, &c, scenario.ctx());

    // unlocked = 500, withdrawn = 0 -> employee earns 500, refund = 1000 - 500.
    assert_eq!(salary::cancellation_refunded(&receipt), 500);
    assert_eq!(salary::cancellation_recipient_received(&receipt), 500);
    assert_eq!(salary::salary_status(&s), salary::status_cancelled());

    // Employee received its earned 500; employer was refunded the unvested 500.
    scenario.next_tx(EMPLOYER);
    let earned = scenario.take_from_address<coin::Coin<SUI>>(EMPLOYEE);
    let refund = scenario.take_from_address<coin::Coin<SUI>>(EMPLOYER);
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

/// Cancelling an already-CANCELLED stream must abort on the status guard, so a
/// second refund cannot be drawn from a stream that was already settled.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_streaming_payroll::EInvalidState,
        location = sui_tunnel::example_streaming_payroll,
    ),
]
fun cancel_twice_aborts() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    c.set_for_testing(mid_ms());
    salary::cancel_salary<SUI>(&mut s, &c, scenario.ctx());

    // The stream is now CANCELLED; a second cancel aborts before any further refund.
    salary::cancel_salary<SUI>(&mut s, &c, scenario.ctx());

    abort
}

/// Claiming at the very start fails: nothing is vested yet, so
/// `available > 0` aborts with insufficient_balance() (== 800).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_streaming_payroll::EInsufficientBalance,
        location = sui_tunnel::example_streaming_payroll,
    ),
]
fun claim_before_anything_vested_aborts() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // Clock still at start -> vested == 0, available == 0 -> abort.
    scenario.next_tx(EMPLOYEE);
    salary::claim_salary<SUI>(&mut s, &c, scenario.ctx());
    abort
}

/// Only the employee may claim: the employer attempting a claim aborts with
/// not_authorized() (== 0).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_streaming_payroll::ENotAuthorized,
        location = sui_tunnel::example_streaming_payroll,
    ),
]
fun non_employee_claim_aborts() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // Employer (the default scenario sender) is not the employee -> not_authorized.
    c.set_for_testing(mid_ms());
    salary::claim_salary<SUI>(&mut s, &c, scenario.ctx());
    abort
}

/// A salary stream with a duration below the module minimum (1 hour) is
/// rejected at creation with invalid_timeout() (== 510).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_streaming_payroll::EInvalidTimeout,
        location = sui_tunnel::example_streaming_payroll,
    ),
]
fun start_below_min_duration_aborts() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let _stream = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms() - 1,
        b"too short",
        &c,
        scenario.ctx(),
    );
    abort
}

/// Employee == employer is rejected at creation with invalid_parties() (== 204).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_streaming_payroll::EInvalidParties,
        location = sui_tunnel::example_streaming_payroll,
    ),
]
fun start_same_party_aborts() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let _stream = salary::start_salary<SUI>(
        EMPLOYER,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );
    abort
}

/// A zero-value payment is rejected at creation with invalid_deposit_amount() (== 801).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_streaming_payroll::EInvalidDepositAmount,
        location = sui_tunnel::example_streaming_payroll,
    ),
]
fun start_zero_payment_aborts() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(0, scenario.ctx());
    let _stream = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );
    abort
}

// ============================================
// FIXED-AMOUNT CLAIM (calls claim_salary_amount)
// ============================================

/// Employee claims a fixed sub-vested amount mid-stream: with 500 vested and a
/// requested 200, the directly-transferred Coin is exactly 200 and
/// withdrawn_amount advances to 200 while the stream stays ACTIVE.
#[test]
fun claim_fixed_amount_transfers_requested_amount() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // Mid-stream 500 is vested; request a sub-vested fixed amount of 200.
    c.set_for_testing(mid_ms());
    assert_eq!(salary::available_balance(&s, mid_ms()), 500);

    scenario.next_tx(EMPLOYEE);
    let receipt = salary::claim_salary_amount<SUI>(&mut s, 200, &c, scenario.ctx());

    assert_eq!(salary::withdrawal_amount(&receipt), 200);
    assert_eq!(salary::salary_withdrawn_amount(&s), 200);
    assert_eq!(salary::salary_status(&s), salary::status_active());
    // Remaining vested slice after the partial claim is 300.
    assert_eq!(salary::available_balance(&s, mid_ms()), 300);

    scenario.next_tx(EMPLOYEE);
    let withdrawn = scenario.take_from_address<coin::Coin<SUI>>(EMPLOYEE);
    assert_eq!(withdrawn.value(), 200);
    withdrawn.burn_for_testing();

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}

/// Requesting more than the vested amount aborts with insufficient_balance()
/// (== 800): at mid-stream only 500 is vested, so 501 is rejected.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_streaming_payroll::EInsufficientBalance,
        location = sui_tunnel::example_streaming_payroll,
    ),
]
fun claim_fixed_amount_over_vested_aborts() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // 500 vested mid-stream; 501 exceeds the available amount -> abort.
    c.set_for_testing(mid_ms());
    scenario.next_tx(EMPLOYEE);
    salary::claim_salary_amount<SUI>(&mut s, 501, &c, scenario.ctx());
    abort
}

// ============================================
// TOP UP (calls top_up_salary)
// ============================================

/// Employer tops up an ACTIVE stream before any vesting with extra funds and
/// additional duration: total_amount and end_time both advance.
#[test]
fun top_up_advances_total_and_end() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    let extra = coin::mint_for_testing<SUI>(500, scenario.ctx());
    salary::top_up_salary<SUI>(&mut s, extra, duration_ms(), &c, scenario.ctx());

    assert_eq!(salary::salary_total_amount(&s), TOTAL + 500);
    assert_eq!(salary::salary_end_time(&s), end_ms() + duration_ms());
    assert_eq!(salary::salary_status(&s), salary::status_active());

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}

/// Only the employer may top up: the employee attempting one aborts with
/// not_authorized() (== 0).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_streaming_payroll::ENotAuthorized,
        location = sui_tunnel::example_streaming_payroll,
    ),
]
fun non_employer_top_up_aborts() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // Employee is not the employer -> not_authorized.
    scenario.next_tx(EMPLOYEE);
    let extra = coin::mint_for_testing<SUI>(500, scenario.ctx());
    salary::top_up_salary<SUI>(&mut s, extra, duration_ms(), &c, scenario.ctx());
    abort
}

/// A zero-value top up is rejected with invalid_deposit_amount() (== 801).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_streaming_payroll::EInvalidDepositAmount,
        location = sui_tunnel::example_streaming_payroll,
    ),
]
fun zero_top_up_aborts() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    let extra = coin::mint_for_testing<SUI>(0, scenario.ctx());
    salary::top_up_salary<SUI>(&mut s, extra, duration_ms(), &c, scenario.ctx());
    abort
}

// ============================================
// CANCEL AUTHORIZATION (calls cancel_salary)
// ============================================

/// Only the employer may cancel: the employee attempting a cancel aborts with
/// not_authorized() (== 0).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_streaming_payroll::ENotAuthorized,
        location = sui_tunnel::example_streaming_payroll,
    ),
]
fun non_employer_cancel_aborts() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let mut s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    // Employee is not the employer -> not_authorized.
    c.set_for_testing(mid_ms());
    scenario.next_tx(EMPLOYEE);
    salary::cancel_salary<SUI>(&mut s, &c, scenario.ctx());
    abort
}

// ============================================
// RATE ACCESSOR (calls rate_per_ms)
// ============================================

/// `rate_per_ms` reports total / (duration in ms). With TOTAL == 1000 over the
/// 1-hour (3_600_000 ms) minimum window the per-ms rate floors to 0.
#[test]
fun rate_per_ms_matches_duration_ms() {
    let mut scenario = test_scenario::begin(EMPLOYER);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(START_MS);

    let payment = coin::mint_for_testing<SUI>(TOTAL, scenario.ctx());
    let s = salary::start_salary<SUI>(
        EMPLOYEE,
        payment,
        duration_ms(),
        b"salary",
        &c,
        scenario.ctx(),
    );

    assert_eq!(salary::rate_per_ms(&s), TOTAL / duration_ms());

    destroy(s);
    c.destroy_for_testing();
    scenario.end();
}
