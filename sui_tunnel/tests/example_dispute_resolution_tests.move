#[test_only]
module sui_tunnel::example_dispute_resolution_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui_tunnel::example_dispute_resolution;
use sui_tunnel::referee;

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
    assert_eq!(config.config_timeout_ms(), TWENTY_FOUR_HOURS_MS);
    assert_eq!(config.config_penalties_enabled(), false);
    assert_eq!(config.config_referee_type(), referee::referee_type_automated());
}

#[test]
fun create_standard_config() {
    let config = example_dispute_resolution::create_standard_config();
    assert_eq!(config.config_timeout_ms(), FOUR_HOURS_MS);
    assert_eq!(config.config_penalties_enabled(), true);
    assert_eq!(config.config_base_penalty(), 500);
    assert_eq!(config.config_penalty_per_hour(), 200);
    assert_eq!(config.config_max_penalty(), 5000);
    assert_eq!(config.config_grace_period_ms(), GRACE_PERIOD_MS);
}

#[test]
fun create_premium_config() {
    let config = example_dispute_resolution::create_premium_config();
    assert_eq!(config.config_timeout_ms(), ONE_HOUR_MS);
    assert_eq!(config.config_penalties_enabled(), true);
    assert_eq!(config.config_base_penalty(), 2000);
    assert_eq!(config.config_penalty_per_hour(), 1000);
    assert_eq!(config.config_max_penalty(), 20000);
    assert_eq!(config.config_referee_type(), referee::referee_type_committee());
}

#[test]
fun get_config_for_level() {
    let basic = example_dispute_resolution::get_config_for_level(0);
    assert_eq!(basic.config_timeout_ms(), TWENTY_FOUR_HOURS_MS);

    let standard = example_dispute_resolution::get_config_for_level(1);
    assert_eq!(standard.config_timeout_ms(), FOUR_HOURS_MS);

    let premium = example_dispute_resolution::get_config_for_level(2);
    assert_eq!(premium.config_timeout_ms(), ONE_HOUR_MS);
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

    assert_eq!(case.case_status(), 0);
    assert_eq!(case.case_service_level(), 0);
    assert_eq!(*case.case_description(), b"Party B stopped responding");
    assert_eq!(case.case_dispute().dispute_id(), 1);
    assert_eq!(case.case_dispute().dispute_raised_by(), @0x0);
    assert_eq!(case.case_dispute().dispute_against(), @0xB);

    case.destroy_case_for_testing();
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

    assert_eq!(case.case_service_level(), 1);
    assert!(case.case_config().config_penalties_enabled());

    case.destroy_case_for_testing();
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

    let result = case.resolve_for_raiser(800, 200, 0, &clock);

    assert_eq!(case.case_status(), 1); // CASE_RESOLVED
    assert_eq!(result.result_winner(), option::some(@0x0));
    assert_eq!(result.result_party_a_amount(), 800);
    assert_eq!(result.result_party_b_amount(), 200);
    assert_eq!(result.result_penalty_amount(), 0);
    assert_eq!(result.result_resolution_method(), 1);

    case.destroy_case_for_testing();
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

    let result = case.resolve_for_respondent(200, 800, 0, &clock);

    assert_eq!(case.case_status(), 1); // CASE_RESOLVED
    assert_eq!(result.result_winner(), option::some(@0xB));
    assert_eq!(result.result_party_a_amount(), 200);
    assert_eq!(result.result_party_b_amount(), 800);
    assert_eq!(result.result_resolution_method(), 2);

    case.destroy_case_for_testing();
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

    let result = case.resolve_split(500, 500, 0, &clock);

    assert_eq!(case.case_status(), 1); // CASE_RESOLVED
    assert_eq!(result.result_winner(), option::none());
    assert_eq!(result.result_party_a_amount(), 500);
    assert_eq!(result.result_party_b_amount(), 500);
    assert_eq!(result.result_resolution_method(), 3);

    case.destroy_case_for_testing();
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

    let _ = case.resolve_for_raiser(800, 200, 0, &clock);
    // Try to resolve again - should fail
    let _ = case.resolve_for_respondent(200, 800, 0, &clock);

    case.destroy_case_for_testing();
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

    assert!(case.can_auto_resolve(&clock));

    // party_a = @0x0 (the raiser from dummy ctx)
    let result = case.auto_resolve_timeout(1000, @0x0, &clock);

    assert_eq!(case.case_status(), 2); // CASE_TIMED_OUT
    assert_eq!(result.result_winner(), option::some(@0x0));
    assert_eq!(result.result_party_a_amount(), 1000);
    assert_eq!(result.result_party_b_amount(), 0);
    assert_eq!(result.result_penalty_amount(), 0);
    assert_eq!(result.result_resolution_method(), 4);

    case.destroy_case_for_testing();
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

    let result = case.auto_resolve_timeout(10000, @0x0, &clock);

    assert_eq!(case.case_status(), 2); // CASE_TIMED_OUT
    // Standard config: base_penalty=500, penalty_per_hour=200, 2 hours elapsed
    // penalty = 500 + 2*200 = 900
    assert_eq!(result.result_penalty_amount(), 900);

    case.destroy_case_for_testing();
    clock::destroy_for_testing(clock);
}

#[test]
fun graduated_penalty_repeat_offender() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);

    // Build history with 2 consecutive timeouts
    let mut history = referee::new_dispute_history();
    history.record_timeout(500);
    history.record_timeout(500);
    assert_eq!(history.history_consecutive_timeouts(), 2);

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
    let penalty = case.calculate_penalty(&clock);
    assert_eq!(penalty, 2100);

    let result = case.auto_resolve_timeout(10000, @0x0, &clock);
    assert_eq!(result.result_penalty_amount(), 2100);

    // After this timeout, consecutive count should be 3
    assert_eq!(case.case_respondent_history().history_consecutive_timeouts(), 3);

    case.destroy_case_for_testing();
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
        history.record_timeout(1000);
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

    let penalty = case.calculate_penalty(&clock);
    // Should be capped at max_penalty = 5000
    assert_eq!(penalty, 5000);

    let result = case.auto_resolve_timeout(10000, @0x0, &clock);
    assert_eq!(result.result_penalty_amount(), 5000);

    case.destroy_case_for_testing();
    clock::destroy_for_testing(clock);
}

#[test]
fun create_arbitration_committee() {
    let members = vector[@0x1, @0x2, @0x3];
    let weights = vector[30u64, 30, 40];
    let committee = example_dispute_resolution::create_arbitration_committee(members, weights, 51);

    assert_eq!(committee.committee_threshold(), 51);
    assert_eq!(committee.committee_total_weight(), 100);
    assert_eq!(committee.committee_member_count(), 3);
}

#[test]
fun committee_voting_quorum() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    // With dummy ctx, all votes come from @0x0 (de-duplicated to 1 effective vote)
    let members = vector[@0x0, @0x1];
    let weights = vector[60u64, 40];
    let committee = example_dispute_resolution::create_arbitration_committee(members, weights, 51);

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
    let committee = example_dispute_resolution::create_arbitration_committee(members, weights, 51);

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
    assert_eq!(case.case_deadline(), FOUR_HOURS_MS);

    case.destroy_case_for_testing();
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
    assert!(!case.can_auto_resolve(&clock));

    case.destroy_case_for_testing();
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

    assert_eq!(result.result_case_number(), 42);
    assert_eq!(result.result_winner(), option::some(@0xABCD));
    assert_eq!(result.result_party_a_amount(), 700);
    assert_eq!(result.result_party_b_amount(), 300);
    assert_eq!(result.result_penalty_amount(), 100);
    assert_eq!(result.result_resolution_method(), 1);
}
