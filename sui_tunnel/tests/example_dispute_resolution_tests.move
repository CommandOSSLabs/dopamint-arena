#[test_only]
module sui_tunnel::example_dispute_resolution_tests;

use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::example_dispute_resolution;
use sui_tunnel::referee;
use sui_tunnel::tunnel;

const TWENTY_FOUR_HOURS_MS: u64 = 86400000;
const FOUR_HOURS_MS: u64 = 14400000;
const ONE_HOUR_MS: u64 = 3600000;
const GRACE_PERIOD_MS: u64 = 1800000;

#[test]
fun service_level_constants() {
    assert_eq!(example_dispute_resolution::service_basic(), 0);
    assert_eq!(example_dispute_resolution::service_standard(), 1);
    assert_eq!(example_dispute_resolution::service_premium(), 2);
}

#[test]
fun case_status_constants() {
    assert_eq!(example_dispute_resolution::case_open(), 0);
    assert_eq!(example_dispute_resolution::case_resolved(), 1);
    assert_eq!(example_dispute_resolution::case_timed_out(), 2);
}

#[test]
fun create_basic_config() {
    let config = example_dispute_resolution::create_basic_config();
    assert_eq!(referee::config_timeout_ms(&config), TWENTY_FOUR_HOURS_MS);
    assert!(!referee::config_penalties_enabled(&config));
    assert_eq!(referee::config_referee_type(&config), referee::referee_type_automated());
}

#[test]
fun create_standard_config() {
    let config = example_dispute_resolution::create_standard_config();
    assert_eq!(referee::config_timeout_ms(&config), FOUR_HOURS_MS);
    assert!(referee::config_penalties_enabled(&config));
    assert_eq!(referee::config_base_penalty(&config), 500);
    assert_eq!(referee::config_penalty_per_hour(&config), 200);
    assert_eq!(referee::config_max_penalty(&config), 5000);
    assert_eq!(referee::config_grace_period_ms(&config), GRACE_PERIOD_MS);
}

#[test]
fun create_premium_config() {
    let config = example_dispute_resolution::create_premium_config();
    assert_eq!(referee::config_timeout_ms(&config), ONE_HOUR_MS);
    assert!(referee::config_penalties_enabled(&config));
    assert_eq!(referee::config_base_penalty(&config), 2000);
    assert_eq!(referee::config_penalty_per_hour(&config), 1000);
    assert_eq!(referee::config_max_penalty(&config), 20000);
    assert_eq!(referee::config_referee_type(&config), referee::referee_type_committee());
}

#[test]
fun get_config_for_level() {
    let basic = example_dispute_resolution::get_config_for_level(0);
    assert_eq!(referee::config_timeout_ms(&basic), TWENTY_FOUR_HOURS_MS);

    let standard = example_dispute_resolution::get_config_for_level(1);
    assert_eq!(referee::config_timeout_ms(&standard), FOUR_HOURS_MS);

    let premium = example_dispute_resolution::get_config_for_level(2);
    assert_eq!(referee::config_timeout_ms(&premium), ONE_HOUR_MS);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_dispute_resolution::EInvalidParameter,
        location = sui_tunnel::example_dispute_resolution,
    ),
]
fun get_config_for_invalid_level() {
    let _ = example_dispute_resolution::get_config_for_level(99);
}

#[test]
fun open_case_basic() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let history = referee::new_dispute_history();

    let case = example_dispute_resolution::open_case(
        1,
        @0xB,
        referee::violation_no_response(),
        b"evidence_hash",
        42,
        b"Party B stopped responding",
        0, // SERVICE_BASIC
        history,
        &clock,
        &mut ctx,
    );

    assert_eq!(example_dispute_resolution::case_status(&case), 0);
    assert_eq!(example_dispute_resolution::case_service_level(&case), 0);
    assert_eq!(*example_dispute_resolution::case_description(&case), b"Party B stopped responding");
    assert_eq!(referee::dispute_id(example_dispute_resolution::case_dispute(&case)), 1);
    assert_eq!(referee::dispute_raised_by(example_dispute_resolution::case_dispute(&case)), @0x0);
    assert_eq!(referee::dispute_against(example_dispute_resolution::case_dispute(&case)), @0xB);

    example_dispute_resolution::destroy_case_for_testing(case);
    clock::destroy_for_testing(clock);
}

#[test]
fun open_case_standard() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let history = referee::new_dispute_history();

    let case = example_dispute_resolution::open_case(
        2,
        @0xB,
        referee::violation_invalid_state(),
        b"state_evidence",
        10,
        b"Invalid state submitted",
        1, // SERVICE_STANDARD
        history,
        &clock,
        &mut ctx,
    );

    assert_eq!(example_dispute_resolution::case_service_level(&case), 1);
    assert!(referee::config_penalties_enabled(example_dispute_resolution::case_config(&case)));

    example_dispute_resolution::destroy_case_for_testing(case);
    clock::destroy_for_testing(clock);
}

#[test]
fun resolve_for_raiser() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let history = referee::new_dispute_history();

    let mut case = example_dispute_resolution::open_case(
        1,
        @0xB,
        referee::violation_no_response(),
        b"evidence",
        5,
        b"Dispute description",
        0, // SERVICE_BASIC
        history,
        &clock,
        &mut ctx,
    );

    let result = example_dispute_resolution::resolve_for_raiser(&mut case, 800, 200, 0, &clock);

    assert_eq!(example_dispute_resolution::case_status(&case), 1); // CASE_RESOLVED
    assert_eq!(example_dispute_resolution::result_winner(&result), option::some(@0x0));
    assert_eq!(example_dispute_resolution::result_party_a_amount(&result), 800);
    assert_eq!(example_dispute_resolution::result_party_b_amount(&result), 200);
    assert_eq!(example_dispute_resolution::result_penalty_amount(&result), 0);
    assert_eq!(example_dispute_resolution::result_resolution_method(&result), 1);

    example_dispute_resolution::destroy_case_for_testing(case);
    clock::destroy_for_testing(clock);
}

#[test]
fun resolve_for_respondent() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let history = referee::new_dispute_history();

    let mut case = example_dispute_resolution::open_case(
        1,
        @0xB,
        referee::violation_no_response(),
        b"evidence",
        5,
        b"Description",
        0, // SERVICE_BASIC
        history,
        &clock,
        &mut ctx,
    );

    let result = example_dispute_resolution::resolve_for_respondent(
        &mut case,
        200,
        800,
        0,
        &clock,
    );

    assert_eq!(example_dispute_resolution::case_status(&case), 1); // CASE_RESOLVED
    assert_eq!(example_dispute_resolution::result_winner(&result), option::some(@0xB));
    assert_eq!(example_dispute_resolution::result_party_a_amount(&result), 200);
    assert_eq!(example_dispute_resolution::result_party_b_amount(&result), 800);
    assert_eq!(example_dispute_resolution::result_resolution_method(&result), 2);

    example_dispute_resolution::destroy_case_for_testing(case);
    clock::destroy_for_testing(clock);
}

#[test]
fun resolve_split() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let history = referee::new_dispute_history();

    let mut case = example_dispute_resolution::open_case(
        1,
        @0xB,
        referee::violation_no_response(),
        b"evidence",
        5,
        b"Description",
        0, // SERVICE_BASIC
        history,
        &clock,
        &mut ctx,
    );

    let result = example_dispute_resolution::resolve_split(&mut case, 500, 500, 0, &clock);

    assert_eq!(example_dispute_resolution::case_status(&case), 1); // CASE_RESOLVED
    assert_eq!(example_dispute_resolution::result_winner(&result), option::none());
    assert_eq!(example_dispute_resolution::result_party_a_amount(&result), 500);
    assert_eq!(example_dispute_resolution::result_party_b_amount(&result), 500);
    assert_eq!(example_dispute_resolution::result_resolution_method(&result), 3);

    example_dispute_resolution::destroy_case_for_testing(case);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_dispute_resolution::EInvalidState,
        location = sui_tunnel::example_dispute_resolution,
    ),
]
fun cannot_resolve_already_resolved() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let history = referee::new_dispute_history();

    let mut case = example_dispute_resolution::open_case(
        1,
        @0xB,
        referee::violation_no_response(),
        b"evidence",
        5,
        b"Description",
        0, // SERVICE_BASIC
        history,
        &clock,
        &mut ctx,
    );

    let _ = example_dispute_resolution::resolve_for_raiser(&mut case, 800, 200, 0, &clock);
    // Try to resolve again - should fail
    let _ = example_dispute_resolution::resolve_for_respondent(&mut case, 200, 800, 0, &clock);

    example_dispute_resolution::destroy_case_for_testing(case);
    clock::destroy_for_testing(clock);
}

#[test]
fun auto_resolve_timeout_basic() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    let history = referee::new_dispute_history();

    let mut case = example_dispute_resolution::open_case(
        1,
        @0xB,
        referee::violation_no_response(),
        b"evidence",
        5,
        b"Timeout test",
        0, // SERVICE_BASIC (24h timeout)
        history,
        &clock,
        &mut ctx,
    );

    // Advance past 24h timeout
    clock::increment_for_testing(&mut clock, TWENTY_FOUR_HOURS_MS + 1);

    assert!(example_dispute_resolution::can_auto_resolve(&case, &clock));

    // party_a = @0x0 (the raiser from dummy ctx)
    let result = example_dispute_resolution::auto_resolve_timeout(
        &mut case,
        1000,
        @0x0,
        &clock,
    );

    assert_eq!(example_dispute_resolution::case_status(&case), 2); // CASE_TIMED_OUT
    assert_eq!(example_dispute_resolution::result_winner(&result), option::some(@0x0));
    assert_eq!(example_dispute_resolution::result_party_a_amount(&result), 1000);
    assert_eq!(example_dispute_resolution::result_party_b_amount(&result), 0);
    assert_eq!(example_dispute_resolution::result_penalty_amount(&result), 0);
    assert_eq!(example_dispute_resolution::result_resolution_method(&result), 4);

    example_dispute_resolution::destroy_case_for_testing(case);
    clock::destroy_for_testing(clock);
}

#[test]
fun auto_resolve_timeout_standard_with_penalty() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    let history = referee::new_dispute_history();

    let mut case = example_dispute_resolution::open_case(
        1,
        @0xB,
        referee::violation_no_response(),
        b"evidence",
        5,
        b"Penalty test",
        1, // SERVICE_STANDARD (4h timeout, penalties enabled)
        history,
        &clock,
        &mut ctx,
    );

    // Advance past 4h timeout + 2 hours
    clock::increment_for_testing(&mut clock, FOUR_HOURS_MS + 2 * ONE_HOUR_MS);

    let result = example_dispute_resolution::auto_resolve_timeout(
        &mut case,
        10000,
        @0x0,
        &clock,
    );

    assert_eq!(example_dispute_resolution::case_status(&case), 2); // CASE_TIMED_OUT
    // Standard config: base_penalty=500, penalty_per_hour=200, 2 hours elapsed
    // penalty = 500 + 2*200 = 900
    assert_eq!(example_dispute_resolution::result_penalty_amount(&result), 900);

    example_dispute_resolution::destroy_case_for_testing(case);
    clock::destroy_for_testing(clock);
}

#[test]
fun graduated_penalty_repeat_offender() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);

    // Build history with 2 consecutive timeouts
    let mut history = referee::new_dispute_history();
    referee::record_timeout(&mut history, 500);
    referee::record_timeout(&mut history, 500);
    assert_eq!(referee::history_consecutive_timeouts(&history), 2);

    let mut case = example_dispute_resolution::open_case(
        3,
        @0xB,
        referee::violation_no_response(),
        b"evidence",
        10,
        b"Repeat offender",
        1, // SERVICE_STANDARD
        history,
        &clock,
        &mut ctx,
    );

    // Advance past timeout + 1 hour
    clock::increment_for_testing(&mut clock, FOUR_HOURS_MS + ONE_HOUR_MS);

    // Calculate penalty manually:
    // base penalty = 500, 1 hour elapsed after timeout -> penalty = 500 + 200 = 700
    // graduated: 700 * (2 consecutive + 1) = 700 * 3 = 2100
    let penalty = example_dispute_resolution::calculate_penalty(&case, &clock);
    assert_eq!(penalty, 2100);

    let result = example_dispute_resolution::auto_resolve_timeout(
        &mut case,
        10000,
        @0x0,
        &clock,
    );
    assert_eq!(example_dispute_resolution::result_penalty_amount(&result), 2100);

    // After this timeout, consecutive count should be 3
    assert_eq!(
        referee::history_consecutive_timeouts(
            example_dispute_resolution::case_respondent_history(&case),
        ),
        3,
    );

    example_dispute_resolution::destroy_case_for_testing(case);
    clock::destroy_for_testing(clock);
}

#[test]
fun penalty_capped_at_max() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);

    // Build massive history
    let mut history = referee::new_dispute_history();
    let mut i = 0u64;
    while (i < 10) {
        referee::record_timeout(&mut history, 1000);
        i = i + 1u64;
    };

    let mut case = example_dispute_resolution::open_case(
        1,
        @0xB,
        referee::violation_no_response(),
        b"evidence",
        1,
        b"Max penalty test",
        1, // SERVICE_STANDARD (max_penalty = 5000)
        history,
        &clock,
        &mut ctx,
    );

    // Advance way past timeout
    clock::increment_for_testing(&mut clock, FOUR_HOURS_MS + 100 * ONE_HOUR_MS);

    let penalty = example_dispute_resolution::calculate_penalty(&case, &clock);
    // Should be capped at max_penalty = 5000
    assert_eq!(penalty, 5000);

    let result = example_dispute_resolution::auto_resolve_timeout(
        &mut case,
        10000,
        @0x0,
        &clock,
    );
    assert_eq!(example_dispute_resolution::result_penalty_amount(&result), 5000);

    example_dispute_resolution::destroy_case_for_testing(case);
    clock::destroy_for_testing(clock);
}

#[test]
fun create_arbitration_committee() {
    let members = vector[@0x1, @0x2, @0x3];
    let weights = vector[30u64, 30, 40];
    let committee = example_dispute_resolution::create_arbitration_committee(
        members,
        weights,
        51,
    );

    assert_eq!(referee::committee_threshold(&committee), 51);
    assert_eq!(referee::committee_total_weight(&committee), 100);
    assert_eq!(referee::committee_member_count(&committee), 3);
}

#[test]
fun committee_voting_quorum() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    // With dummy ctx, all votes come from @0x0 (de-duplicated to 1 effective vote)
    let members = vector[@0x0, @0x1];
    let weights = vector[60u64, 40];
    let committee = example_dispute_resolution::create_arbitration_committee(
        members,
        weights,
        51,
    );

    let vote1 = example_dispute_resolution::committee_vote(true, 500, &clock, &ctx);

    let votes = vector[vote1];

    // @0x0 has weight 60, meets 51 threshold
    assert!(example_dispute_resolution::has_quorum_for_raiser(&committee, &votes));
    // No votes against raiser, doesn't meet 51 threshold
    assert!(!example_dispute_resolution::has_quorum_for_respondent(&committee, &votes));

    clock::destroy_for_testing(clock);
}

#[test]
fun committee_voting_no_quorum() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    // @0x0 has weight 25, not enough for 51 threshold
    let members = vector[@0x0, @0x1, @0x2, @0x3];
    let weights = vector[25u64, 25, 25, 25];
    let committee = example_dispute_resolution::create_arbitration_committee(
        members,
        weights,
        51,
    );

    let vote1 = example_dispute_resolution::committee_vote(true, 500, &clock, &ctx);
    let votes = vector[vote1];

    assert!(!example_dispute_resolution::has_quorum_for_raiser(&committee, &votes));
    assert!(!example_dispute_resolution::has_quorum_for_respondent(&committee, &votes));

    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_dispute_resolution::EInvalidParameter,
        location = sui_tunnel::example_dispute_resolution,
    ),
]
fun create_committee_mismatched_lengths() {
    let members = vector[@0x1, @0x2];
    let weights = vector[50u64];
    let _ = example_dispute_resolution::create_arbitration_committee(members, weights, 51);
}

#[test]
fun case_deadline() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let history = referee::new_dispute_history();

    let case = example_dispute_resolution::open_case(
        1,
        @0xB,
        referee::violation_no_response(),
        b"evidence",
        1,
        b"Deadline test",
        1, // SERVICE_STANDARD (4h timeout)
        history,
        &clock,
        &mut ctx,
    );

    // Deadline should be now + 4 hours
    assert_eq!(example_dispute_resolution::case_deadline(&case), FOUR_HOURS_MS);

    example_dispute_resolution::destroy_case_for_testing(case);
    clock::destroy_for_testing(clock);
}

#[test]
fun cannot_auto_resolve_before_timeout() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    let history = referee::new_dispute_history();

    let case = example_dispute_resolution::open_case(
        1,
        @0xB,
        referee::violation_no_response(),
        b"evidence",
        1,
        b"Not yet timed out",
        0, // SERVICE_BASIC (24h timeout)
        history,
        &clock,
        &mut ctx,
    );

    // Only advance 1 hour (24h timeout)
    clock::increment_for_testing(&mut clock, ONE_HOUR_MS);
    assert!(!example_dispute_resolution::can_auto_resolve(&case, &clock));

    example_dispute_resolution::destroy_case_for_testing(case);
    clock::destroy_for_testing(clock);
}

#[test]
fun arbitration_result_accessors() {
    let result = example_dispute_resolution::create_arbitration_result_for_testing(
        42,
        option::some(@0xABCD),
        700,
        300,
        100,
        1,
    );

    assert_eq!(example_dispute_resolution::result_case_number(&result), 42);
    assert_eq!(example_dispute_resolution::result_winner(&result), option::some(@0xABCD));
    assert_eq!(example_dispute_resolution::result_party_a_amount(&result), 700);
    assert_eq!(example_dispute_resolution::result_party_b_amount(&result), 300);
    assert_eq!(example_dispute_resolution::result_penalty_amount(&result), 100);
    assert_eq!(example_dispute_resolution::result_resolution_method(&result), 1);
}

// ============================================
// ON-CHAIN ARBITRATION (REAL FUND MOVEMENT)
// ============================================

const PARTY_A: address = @0xA11CE;
const PARTY_B: address = @0xB0B;
const REFEREE: address = @0xC0FFEE;
const PK_A: vector<u8> = x"1111111111111111111111111111111111111111111111111111111111111111";
const PK_B: vector<u8> = x"2222222222222222222222222222222222222222222222222222222222222222";
const FUND_START_MS: u64 = 1000;

/// Opens a standard-service funded case (PARTY_A is the sender/raiser, against
/// PARTY_B), then joins PARTY_B so the tunnel activates. Leaves the sender as PARTY_B.
fun open_and_join(
    scenario: &mut test_scenario::Scenario,
    clock: &clock::Clock,
    deposit_a: u64,
    deposit_b: u64,
): example_dispute_resolution::FundedDisputeCase<SUI> {
    let coin_a = coin::mint_for_testing<SUI>(deposit_a, scenario.ctx());
    let mut case = example_dispute_resolution::open_funded_case<SUI>(
        1,
        PK_A,
        PARTY_B,
        PK_B,
        PARTY_B,
        0,
        b"evidence",
        0,
        b"late delivery",
        example_dispute_resolution::service_standard(),
        referee::new_dispute_history(),
        REFEREE,
        coin_a,
        clock,
        scenario.ctx(),
    );

    scenario.next_tx(PARTY_B);
    let coin_b = coin::mint_for_testing<SUI>(deposit_b, scenario.ctx());
    example_dispute_resolution::join_funded_case<SUI>(&mut case, coin_b, clock, scenario.ctx());
    case
}

#[test]
fun open_funded_case_custodies_real_funds() {
    let mut scenario = test_scenario::begin(PARTY_A);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let case = open_and_join(&mut scenario, &clock, 1000, 1000);

    assert_eq!(example_dispute_resolution::funded_case_total_balance(&case), 2000);
    assert_eq!(
        example_dispute_resolution::funded_case_status(&case),
        example_dispute_resolution::case_open(),
    );
    let tun = example_dispute_resolution::funded_case_tunnel(&case);
    assert!(tunnel::is_active(tun));
    assert!(tunnel::has_referee(tun));
    assert_eq!(tunnel::get_referee(tun), REFEREE);

    example_dispute_resolution::destroy_funded_case_for_testing(case);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun cancel_before_join_refunds_party_a() {
    let mut scenario = test_scenario::begin(PARTY_A);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let coin_a = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut case = example_dispute_resolution::open_funded_case<SUI>(
        1,
        PK_A,
        PARTY_B,
        PK_B,
        PARTY_B,
        0,
        b"evidence",
        0,
        b"late delivery",
        example_dispute_resolution::service_standard(),
        referee::new_dispute_history(),
        REFEREE,
        coin_a,
        &clock,
        scenario.ctx(),
    );

    // PARTY_B never joins; PARTY_A reclaims the full escrowed deposit.
    let refund = example_dispute_resolution::cancel_funded_case<SUI>(
        &mut case,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(refund.value(), 1000);
    assert_eq!(
        example_dispute_resolution::funded_case_status(&case),
        example_dispute_resolution::case_resolved(),
    );
    assert!(tunnel::is_closed(example_dispute_resolution::funded_case_tunnel(&case)));

    refund.burn_for_testing();
    example_dispute_resolution::destroy_funded_case_for_testing(case);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun referee_split_settlement_transfers_funds() {
    let mut scenario = test_scenario::begin(PARTY_A);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut case = open_and_join(&mut scenario, &clock, 1000, 1000);

    // Either party escalates the dispute on-chain (sender is PARTY_B after join).
    example_dispute_resolution::escalate_to_chain(&mut case, &clock, scenario.ctx());

    // The assigned referee splits the disputed funds 1200/800.
    scenario.next_tx(REFEREE);
    example_dispute_resolution::resolve_split_and_settle(
        &mut case,
        1200,
        800,
        0,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(
        example_dispute_resolution::funded_case_status(&case),
        example_dispute_resolution::case_resolved(),
    );
    assert!(tunnel::is_closed(example_dispute_resolution::funded_case_tunnel(&case)));

    scenario.next_tx(PARTY_A);
    let to_a = scenario.take_from_address<coin::Coin<SUI>>(PARTY_A);
    assert_eq!(to_a.value(), 1200);
    to_a.burn_for_testing();

    scenario.next_tx(PARTY_B);
    let to_b = scenario.take_from_address<coin::Coin<SUI>>(PARTY_B);
    assert_eq!(to_b.value(), 800);
    to_b.burn_for_testing();

    example_dispute_resolution::destroy_funded_case_for_testing(case);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun referee_awards_full_balance_to_raiser() {
    let mut scenario = test_scenario::begin(PARTY_A);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut case = open_and_join(&mut scenario, &clock, 1500, 500);
    example_dispute_resolution::escalate_to_chain(&mut case, &clock, scenario.ctx());

    scenario.next_tx(REFEREE);
    example_dispute_resolution::resolve_for_raiser_and_settle(
        &mut case,
        2000,
        0,
        0,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(PARTY_A);
    let to_a = scenario.take_from_address<coin::Coin<SUI>>(PARTY_A);
    assert_eq!(to_a.value(), 2000);
    to_a.burn_for_testing();

    example_dispute_resolution::destroy_funded_case_for_testing(case);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun timeout_auto_resolution_awards_raiser_full_balance() {
    let mut scenario = test_scenario::begin(PARTY_A);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut case = open_and_join(&mut scenario, &clock, 1000, 1000);
    example_dispute_resolution::escalate_to_chain(&mut case, &clock, scenario.ctx());

    // Advance past the standard-service dispute deadline (4h) so the referee can
    // auto-resolve. The unresponsive respondent forfeits the full balance.
    clock.set_for_testing(FUND_START_MS + FOUR_HOURS_MS + 1);

    scenario.next_tx(REFEREE);
    example_dispute_resolution::auto_resolve_timeout_and_settle(
        &mut case,
        &clock,
        scenario.ctx(),
    );
    assert!(tunnel::is_closed(example_dispute_resolution::funded_case_tunnel(&case)));

    scenario.next_tx(PARTY_A);
    let to_a = scenario.take_from_address<coin::Coin<SUI>>(PARTY_A);
    assert_eq!(to_a.value(), 2000);
    to_a.burn_for_testing();

    example_dispute_resolution::destroy_funded_case_for_testing(case);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun force_close_fallback_returns_disputed_balances() {
    let mut scenario = test_scenario::begin(PARTY_A);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut case = open_and_join(&mut scenario, &clock, 1000, 1000);

    // PARTY_A escalates so PARTY_A becomes the tunnel dispute_raiser.
    scenario.next_tx(PARTY_A);
    example_dispute_resolution::escalate_to_chain(&mut case, &clock, scenario.ctx());
    assert!(!example_dispute_resolution::can_force_close(&case, &clock));

    // Advance past the tunnel timeout (standard = 4h) so the raiser can force-close.
    clock.set_for_testing(FUND_START_MS + FOUR_HOURS_MS + 1);
    assert!(example_dispute_resolution::can_force_close(&case, &clock));

    example_dispute_resolution::force_close_fallback(&mut case, &clock, scenario.ctx());

    scenario.next_tx(PARTY_A);
    let to_a = scenario.take_from_address<coin::Coin<SUI>>(PARTY_A);
    assert_eq!(to_a.value(), 1000);
    to_a.burn_for_testing();

    scenario.next_tx(PARTY_B);
    let to_b = scenario.take_from_address<coin::Coin<SUI>>(PARTY_B);
    assert_eq!(to_b.value(), 1000);
    to_b.burn_for_testing();

    example_dispute_resolution::destroy_funded_case_for_testing(case);
    clock.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::ERefereeNotAuthorized,
        location = sui_tunnel::tunnel,
    ),
]
fun non_referee_cannot_settle() {
    let mut scenario = test_scenario::begin(PARTY_A);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut case = open_and_join(&mut scenario, &clock, 1000, 1000);
    example_dispute_resolution::escalate_to_chain(&mut case, &clock, scenario.ctx());

    // PARTY_A is a tunnel party but not the assigned referee.
    scenario.next_tx(PARTY_A);
    example_dispute_resolution::resolve_for_raiser_and_settle(
        &mut case,
        2000,
        0,
        0,
        &clock,
        scenario.ctx(),
    );

    // Unreachable; present so the test type-checks.
    destroy(case);
    clock.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EBalanceSumMismatch,
        location = sui_tunnel::tunnel,
    ),
]
fun settlement_must_conserve_balance() {
    let mut scenario = test_scenario::begin(PARTY_A);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut case = open_and_join(&mut scenario, &clock, 1000, 1000);
    example_dispute_resolution::escalate_to_chain(&mut case, &clock, scenario.ctx());

    // Amounts sum to 1500, not the 2000 held by the tunnel.
    scenario.next_tx(REFEREE);
    example_dispute_resolution::resolve_split_and_settle(
        &mut case,
        1000,
        500,
        0,
        &clock,
        scenario.ctx(),
    );

    // Unreachable; present so the test type-checks.
    destroy(case);
    clock.destroy_for_testing();
    scenario.end();
}
