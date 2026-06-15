#[test_only]
module sui_tunnel::referee_tests;

use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::test_scenario;
use sui_tunnel::referee;

/// One hour in milliseconds, mirroring `ONE_HOUR_MS` in the source.
const ONE_HOUR_MS: u64 = 3600000;

#[test]
fun referee_type_constants() {
    assert_eq!(referee::referee_type_automated(), 0);
    assert_eq!(referee::referee_type_designated(), 1);
    assert_eq!(referee::referee_type_committee(), 2);
}

#[test]
fun dispute_status_constants() {
    assert_eq!(referee::dispute_status_none(), 0);
    assert_eq!(referee::dispute_status_raised(), 1);
    assert_eq!(referee::dispute_status_under_review(), 2);
    assert_eq!(referee::dispute_status_resolved_a(), 3);
    assert_eq!(referee::dispute_status_resolved_b(), 4);
    assert_eq!(referee::dispute_status_resolved_split(), 5);
    assert_eq!(referee::dispute_status_timed_out(), 6);
}

#[test]
fun violation_constants() {
    assert_eq!(referee::violation_no_response(), 0);
    assert_eq!(referee::violation_invalid_state(), 1);
    assert_eq!(referee::violation_double_spend(), 2);
    assert_eq!(referee::violation_forgery(), 3);
}

#[test]
fun default_config() {
    let config = referee::default_config();
    assert_eq!(referee::config_referee_type(&config), 0);
    assert_eq!(referee::config_timeout_ms(&config), 3600000);
    assert_eq!(referee::config_penalties_enabled(&config), false);
}

#[test]
fun create_timeout_config() {
    let timeout = 7200000u64; // 2 hours
    let config = referee::create_timeout_config(timeout);
    assert_eq!(referee::config_timeout_ms(&config), timeout);
    assert_eq!(referee::config_penalties_enabled(&config), false);
}

#[test]
fun create_penalty_config() {
    let config = referee::create_penalty_config(3600000, 1000, 500, 5000);
    assert_eq!(referee::config_timeout_ms(&config), 3600000);
    assert_eq!(referee::config_base_penalty(&config), 1000);
    assert_eq!(referee::config_penalty_per_hour(&config), 500);
    assert_eq!(referee::config_max_penalty(&config), 5000);
    assert_eq!(referee::config_penalties_enabled(&config), true);
}

/// Builds a `Clock` frozen at `now_ms` for deterministic time-based assertions.
fun clock_at(now_ms: u64, ctx: &mut TxContext): clock::Clock {
    let mut c = clock::create_for_testing(ctx);
    c.set_for_testing(now_ms);
    c
}

/// Drives `calculate_penalty` through the exact arithmetic in the source.
///
/// Config: timeout=1h, base=1000, per_hour=500, max=5000, last_activity=0.
/// `deadline = last_activity + timeout = 3_600_000`.
/// `elapsed = max(0, now - deadline)`, `hours = elapsed / 3_600_000`,
/// `penalty = min(max_penalty, base + hours * per_hour)` (0 when elapsed == 0).
#[test]
fun calculate_penalty_grows_then_caps() {
    let mut ctx = sui::tx_context::dummy();
    let config = referee::create_penalty_config(ONE_HOUR_MS, 1000, 500, 5000);
    let last_activity = 0u64;

    // Exactly at the deadline: elapsed == 0 -> penalty is 0.
    let c0 = clock_at(ONE_HOUR_MS, &mut ctx);
    assert_eq!(referee::calculate_penalty(&config, last_activity, &c0), 0);
    destroy(c0);

    // Just after the deadline (elapsed == 1ms): hours == 0, so only the base.
    let c1 = clock_at(ONE_HOUR_MS + 1, &mut ctx);
    assert_eq!(referee::calculate_penalty(&config, last_activity, &c1), 1000);
    destroy(c1);

    // One full hour past the deadline: base + 1 * 500 = 1500.
    let c_1h = clock_at(ONE_HOUR_MS + ONE_HOUR_MS, &mut ctx);
    assert_eq!(referee::calculate_penalty(&config, last_activity, &c_1h), 1500);
    destroy(c_1h);

    // Two full hours past the deadline: base + 2 * 500 = 2000.
    let c_2h = clock_at(ONE_HOUR_MS + 2 * ONE_HOUR_MS, &mut ctx);
    assert_eq!(referee::calculate_penalty(&config, last_activity, &c_2h), 2000);
    destroy(c_2h);

    // Eight full hours: base + 8 * 500 = 5000, exactly the cap (not yet clamped).
    let c_8h = clock_at(ONE_HOUR_MS + 8 * ONE_HOUR_MS, &mut ctx);
    assert_eq!(referee::calculate_penalty(&config, last_activity, &c_8h), 5000);
    destroy(c_8h);

    // Nine full hours: base + 9 * 500 = 5500 -> clamped to max_penalty 5000.
    let c_9h = clock_at(ONE_HOUR_MS + 9 * ONE_HOUR_MS, &mut ctx);
    assert_eq!(referee::calculate_penalty(&config, last_activity, &c_9h), 5000);
    destroy(c_9h);
}

/// A config with penalties disabled (e.g. via `create_timeout_config`) always
/// returns 0 regardless of how long ago the timeout was.
#[test]
fun calculate_penalty_disabled_is_zero() {
    let mut ctx = sui::tx_context::dummy();
    let config = referee::create_timeout_config(ONE_HOUR_MS);

    // Far past the deadline, but penalties are disabled.
    let c = clock_at(ONE_HOUR_MS + 100 * ONE_HOUR_MS, &mut ctx);
    assert_eq!(referee::calculate_penalty(&config, 0, &c), 0);
    destroy(c);
}

/// `calculate_graduated_penalty` multiplies the base penalty by
/// `consecutive_timeouts + 1` (min 1x) and re-caps at `max_penalty`.
#[test]
fun calculate_graduated_penalty_scales_and_caps() {
    let mut ctx = sui::tx_context::dummy();
    let config = referee::create_penalty_config(ONE_HOUR_MS, 1000, 500, 5000);

    // One hour past timeout -> base penalty is 1500 (from the test above).
    let c = clock_at(ONE_HOUR_MS + ONE_HOUR_MS, &mut ctx);

    // No consecutive timeouts -> multiplier 1x -> 1500.
    let mut history = referee::new_dispute_history();
    assert_eq!(referee::calculate_graduated_penalty(&config, &history, 0, &c), 1500);

    // One consecutive timeout -> multiplier 2x -> 3000.
    referee::record_timeout(&mut history, 0);
    assert_eq!(referee::history_consecutive_timeouts(&history), 1);
    assert_eq!(referee::calculate_graduated_penalty(&config, &history, 0, &c), 3000);

    // Two consecutive timeouts -> multiplier 3x -> 4500.
    referee::record_timeout(&mut history, 0);
    assert_eq!(referee::calculate_graduated_penalty(&config, &history, 0, &c), 4500);

    // Three consecutive timeouts -> 1500 * 4 = 6000 -> clamped to max 5000.
    referee::record_timeout(&mut history, 0);
    assert_eq!(referee::calculate_graduated_penalty(&config, &history, 0, &c), 5000);

    destroy(c);
}

#[test]
fun safe_penalty() {
    assert_eq!(referee::safe_penalty(100, 1000), 100);
    assert_eq!(referee::safe_penalty(1000, 1000), 1000);
    assert_eq!(referee::safe_penalty(2000, 1000), 1000);
}

#[test]
fun would_exceed_deposit() {
    assert!(!referee::would_exceed_deposit(100, 1000));
    assert!(!referee::would_exceed_deposit(1000, 1000));
    assert!(referee::would_exceed_deposit(1001, 1000));
}

#[test]
fun dispute_history() {
    let mut history = referee::new_dispute_history();
    assert_eq!(referee::history_disputes_raised(&history), 0);
    assert_eq!(referee::history_consecutive_timeouts(&history), 0);

    referee::record_dispute_raised(&mut history);
    assert_eq!(referee::history_disputes_raised(&history), 1);

    referee::record_dispute_against(&mut history);
    assert_eq!(referee::history_disputes_against(&history), 1);

    referee::record_dispute_won(&mut history);
    assert_eq!(referee::history_disputes_won(&history), 1);

    referee::record_timeout(&mut history, 500);
    assert_eq!(referee::history_consecutive_timeouts(&history), 1);
    assert_eq!(referee::history_total_penalties_paid(&history), 500);

    referee::record_timeout(&mut history, 1000);
    assert_eq!(referee::history_consecutive_timeouts(&history), 2);
    assert_eq!(referee::history_total_penalties_paid(&history), 1500);

    referee::reset_consecutive_timeouts(&mut history);
    assert_eq!(referee::history_consecutive_timeouts(&history), 0);
}

#[test]
fun empty_resolution() {
    let resolution = referee::empty_resolution();
    assert_eq!(referee::resolution_party_a_amount(&resolution), 0);
    assert_eq!(referee::resolution_party_b_amount(&resolution), 0);
    assert_eq!(referee::resolution_penalty_deducted(&resolution), 0);
    assert_eq!(referee::resolution_reason(&resolution), 0);
}

#[test]
fun create_resolution() {
    let resolution = referee::create_resolution(1000, 500, 100, 1);
    assert_eq!(referee::resolution_party_a_amount(&resolution), 1000);
    assert_eq!(referee::resolution_party_b_amount(&resolution), 500);
    assert_eq!(referee::resolution_penalty_deducted(&resolution), 100);
    assert_eq!(referee::resolution_reason(&resolution), 1);
}

#[test]
fun committee_operations() {
    let mut committee = referee::create_committee(60);
    assert_eq!(referee::committee_threshold(&committee), 60);
    assert_eq!(referee::committee_total_weight(&committee), 0);
    assert_eq!(referee::committee_member_count(&committee), 0);

    referee::add_committee_member(&mut committee, @0x1, 40);
    assert_eq!(referee::committee_total_weight(&committee), 40);
    assert_eq!(referee::committee_member_count(&committee), 1);

    referee::add_committee_member(&mut committee, @0x2, 30);
    assert_eq!(referee::committee_total_weight(&committee), 70);

    referee::add_committee_member(&mut committee, @0x3, 30);
    assert_eq!(referee::committee_total_weight(&committee), 100);

    referee::remove_committee_member(&mut committee, @0x2);
    assert_eq!(referee::committee_total_weight(&committee), 70);
}

#[test]
fun votes_meet_threshold() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    // With dummy ctx, all votes come from @0x0 (de-duplicated to 1 effective vote)
    let mut committee = referee::create_committee(50);
    referee::add_committee_member(&mut committee, @0x0, 60);
    referee::add_committee_member(&mut committee, @0x1, 40);

    let vote1 = referee::create_vote(true, 0, &clock, &ctx);

    let votes = vector[vote1];

    // @0x0 has weight 60, meets 50 threshold
    assert!(referee::votes_meet_threshold(&committee, &votes, true));
    // No votes against A, doesn't meet 50 threshold
    assert!(!referee::votes_meet_threshold(&committee, &votes, false));

    clock::destroy_for_testing(clock);
}

/// Exercises one-vote-per-member dedup across DISTINCT voters.
///
/// `test_scenario::next_tx(scenario, addr)` makes `ctx.sender()` equal `addr`
/// for the transaction, so each `create_vote` records a different `voter`.
/// Committee: @0x1=20, @0x2=30, @0x3=50 (total 100), threshold 60.
#[test]
fun votes_meet_threshold_distinct_voters() {
    let mut scenario = test_scenario::begin(@0x1);
    let clock = clock::create_for_testing(scenario.ctx());

    let mut committee = referee::create_committee(60);
    referee::add_committee_member(&mut committee, @0x1, 20);
    referee::add_committee_member(&mut committee, @0x2, 30);
    referee::add_committee_member(&mut committee, @0x3, 50);
    assert_eq!(referee::committee_total_weight(&committee), 100);

    // Vote from @0x1 (weight 20).
    scenario.next_tx(@0x1);
    let v_a1 = referee::create_vote(true, 0, &clock, scenario.ctx());
    assert_eq!(referee::vote_voter(&v_a1), @0x1);

    // Vote from @0x2 (weight 30).
    scenario.next_tx(@0x2);
    let v_a2 = referee::create_vote(true, 0, &clock, scenario.ctx());
    assert_eq!(referee::vote_voter(&v_a2), @0x2);

    // 20 + 30 = 50 < 60: two distinct voters still below threshold.
    let two_votes = vector[v_a1, v_a2];
    assert!(!referee::votes_meet_threshold(&committee, &two_votes, true));

    // Add @0x3 (weight 50): 20 + 30 + 50 = 100 >= 60: threshold met.
    scenario.next_tx(@0x3);
    let v_a3 = referee::create_vote(true, 0, &clock, scenario.ctx());
    let three_votes = vector[v_a1, v_a2, v_a3];
    assert!(referee::votes_meet_threshold(&committee, &three_votes, true));

    clock::destroy_for_testing(clock);
    scenario.end();
}

/// A duplicate vote from the SAME distinct voter must not be double-counted.
///
/// Committee: @0x1=50, @0x2=40, threshold 60. Two votes from @0x1 contribute
/// 50 once (deduped) -> below 60; adding @0x2 reaches 90 >= 60.
#[test]
fun votes_meet_threshold_dedups_same_voter() {
    let mut scenario = test_scenario::begin(@0x1);
    let clock = clock::create_for_testing(scenario.ctx());

    let mut committee = referee::create_committee(60);
    referee::add_committee_member(&mut committee, @0x1, 50);
    referee::add_committee_member(&mut committee, @0x2, 40);

    // Two separate votes, both genuinely from @0x1.
    scenario.next_tx(@0x1);
    let v1 = referee::create_vote(true, 0, &clock, scenario.ctx());
    scenario.next_tx(@0x1);
    let v2 = referee::create_vote(true, 0, &clock, scenario.ctx());
    assert_eq!(referee::vote_voter(&v1), @0x1);
    assert_eq!(referee::vote_voter(&v2), @0x1);

    // Dedup: @0x1's weight (50) counts once, not 100 -> below threshold 60.
    let dup_votes = vector[v1, v2];
    assert!(!referee::votes_meet_threshold(&committee, &dup_votes, true));

    // Distinct second voter @0x2 (40) pushes the deduped total to 90 >= 60.
    scenario.next_tx(@0x2);
    let v3 = referee::create_vote(true, 0, &clock, scenario.ctx());
    let mixed_votes = vector[v1, v2, v3];
    assert!(referee::votes_meet_threshold(&committee, &mixed_votes, true));

    clock::destroy_for_testing(clock);
    scenario.end();
}

/// Non-member votes are silently ignored; only weight from active members
/// counts toward the threshold.
#[test]
fun votes_meet_threshold_ignores_non_members() {
    let mut scenario = test_scenario::begin(@0x1);
    let clock = clock::create_for_testing(scenario.ctx());

    let mut committee = referee::create_committee(60);
    referee::add_committee_member(&mut committee, @0x1, 50);

    // @0x1 is a member (50); @0x9 is NOT a committee member (ignored).
    scenario.next_tx(@0x1);
    let v_member = referee::create_vote(true, 0, &clock, scenario.ctx());
    scenario.next_tx(@0x9);
    let v_outsider = referee::create_vote(true, 0, &clock, scenario.ctx());

    // Only 50 counts (outsider ignored) -> below 60.
    let votes = vector[v_member, v_outsider];
    assert!(!referee::votes_meet_threshold(&committee, &votes, true));

    clock::destroy_for_testing(clock);
    scenario.end();
}

/// A removed (inactive) member's vote no longer counts toward the threshold.
#[test]
fun votes_meet_threshold_excludes_removed_member() {
    let mut scenario = test_scenario::begin(@0x1);
    let clock = clock::create_for_testing(scenario.ctx());

    let mut committee = referee::create_committee(60);
    referee::add_committee_member(&mut committee, @0x1, 50);
    referee::add_committee_member(&mut committee, @0x2, 40);

    scenario.next_tx(@0x1);
    let v1 = referee::create_vote(true, 0, &clock, scenario.ctx());
    scenario.next_tx(@0x2);
    let v2 = referee::create_vote(true, 0, &clock, scenario.ctx());

    // Before removal: 50 + 40 = 90 >= 60.
    let votes = vector[v1, v2];
    assert!(referee::votes_meet_threshold(&committee, &votes, true));

    // Deactivate @0x2: only @0x1's 50 remains -> below 60.
    referee::remove_committee_member(&mut committee, @0x2);
    assert!(!referee::votes_meet_threshold(&committee, &votes, true));

    clock::destroy_for_testing(clock);
    scenario.end();
}

#[test]
fun vote_accessors() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let vote = referee::create_vote(true, 1000, &clock, &ctx);
    assert_eq!(referee::vote_voter(&vote), @0x0);
    assert_eq!(referee::vote_in_favor_of_a(&vote), true);
    assert_eq!(referee::vote_suggested_penalty(&vote), 1000);

    clock::destroy_for_testing(clock);
}

// ============================================
// CONFIG VALIDATION NEGATIVES
// ============================================

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::referee::EInvalidParameter,
        location = sui_tunnel::referee,
    ),
]
fun create_timeout_config_zero_timeout_aborts() {
    // assert_valid_timeout rejects timeout_ms == 0.
    let _config = referee::create_timeout_config(0);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::referee::EInvalidParameter,
        location = sui_tunnel::referee,
    ),
]
fun create_penalty_config_zero_timeout_aborts() {
    // assert_valid_timeout rejects timeout_ms == 0 (checked before the cap check).
    let _config = referee::create_penalty_config(0, 100, 10, 1000);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::referee::EInvalidParameter,
        location = sui_tunnel::referee,
    ),
]
fun create_penalty_config_max_below_base_aborts() {
    // max_penalty (50) < base_penalty (100) violates the cap invariant.
    let _config = referee::create_penalty_config(ONE_HOUR_MS, 100, 10, 50);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::referee::EInvalidParameter,
        location = sui_tunnel::referee,
    ),
]
fun create_config_bad_referee_type_aborts() {
    // referee_type 3 is above REFEREE_TYPE_COMMITTEE (2).
    let _config = referee::create_config(3, ONE_HOUR_MS, 0, 0, 0, 0, false, 0);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::referee::EInvalidParameter,
        location = sui_tunnel::referee,
    ),
]
fun create_config_zero_timeout_aborts() {
    let _config = referee::create_config(0, 0, 0, 0, 0, 0, false, 0);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::referee::EInvalidParameter,
        location = sui_tunnel::referee,
    ),
]
fun add_committee_member_zero_weight_aborts() {
    let mut committee = referee::create_committee(60);
    // weight must be > 0.
    referee::add_committee_member(&mut committee, @0x1, 0);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::referee::EInvalidParameter,
        location = sui_tunnel::referee,
    ),
]
fun add_committee_member_duplicate_active_aborts() {
    let mut committee = referee::create_committee(60);
    referee::add_committee_member(&mut committee, @0x1, 30);
    // Re-adding the same active address is rejected.
    referee::add_committee_member(&mut committee, @0x1, 30);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::referee::ENoActiveDispute,
        location = sui_tunnel::referee,
    ),
]
fun resolve_for_a_on_resolved_dispute_aborts() {
    let mut scenario = test_scenario::begin(@0x1);
    let clock = clock::create_for_testing(scenario.ctx());
    let config = referee::create_timeout_config(ONE_HOUR_MS);

    let mut dispute = referee::create_dispute(
        1,
        @0x2,
        referee::violation_no_response(),
        b"evidence",
        0,
        &config,
        &clock,
        scenario.ctx(),
    );

    // First resolution moves the dispute out of RAISED.
    referee::resolve_for_a(&mut dispute, 100, 0, 0, &clock);
    // Second resolution must abort: no longer an active dispute.
    referee::resolve_for_a(&mut dispute, 100, 0, 0, &clock);

    clock::destroy_for_testing(clock);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::referee::ETimeoutNotReached,
        location = sui_tunnel::referee,
    ),
]
fun auto_resolve_before_deadline_aborts() {
    let mut scenario = test_scenario::begin(@0x1);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(0);
    let config = referee::create_timeout_config(ONE_HOUR_MS);

    // Deadline = now (0) + timeout (1h) = 3_600_000.
    let mut dispute = referee::create_dispute(
        1,
        @0x2,
        referee::violation_no_response(),
        b"evidence",
        0,
        &config,
        &clock,
        scenario.ctx(),
    );

    // Still before the deadline -> can_auto_resolve is false -> abort.
    referee::auto_resolve_timeout(&mut dispute, 1000, 0, @0x1, &clock);

    clock::destroy_for_testing(clock);
    scenario.end();
}

// ============================================
// OVERFLOW / UNDERFLOW SAFETY
// ============================================

/// `is_response_too_fast` treats request_time > now as "too fast" instead of
/// underflowing `now - request_time`.
#[test]
fun is_response_too_fast_handles_future_request() {
    let mut ctx = sui::tx_context::dummy();
    // min_response_time_ms must be non-zero for the check to engage.
    let config = referee::create_config(0, ONE_HOUR_MS, 0, 0, 0, 0, false, 1000);

    // now (100) is BEFORE request_time (5000): no underflow, returns true.
    let c = clock_at(100, &mut ctx);
    assert!(referee::is_response_too_fast(&config, 5000, &c));

    // now (100) == request_time (100): still "too fast" (now <= request_time).
    assert!(referee::is_response_too_fast(&config, 100, &c));
    destroy(c);

    // A genuinely slow response (elapsed >= min) is NOT too fast.
    let c2 = clock_at(5000, &mut ctx);
    assert!(!referee::is_response_too_fast(&config, 100, &c2));
    destroy(c2);
}

/// With `min_response_time_ms == 0` the anti-spam check is disabled and never
/// reports "too fast", even when request_time is far in the future.
#[test]
fun is_response_too_fast_disabled_when_min_zero() {
    let mut ctx = sui::tx_context::dummy();
    let config = referee::create_timeout_config(ONE_HOUR_MS); // min_response_time_ms = 0
    let c = clock_at(0, &mut ctx);
    assert!(!referee::is_response_too_fast(&config, u64_max(), &c));
    destroy(c);
}

/// Timeout helpers widen to u128 internally, so a near-`u64::MAX` last_activity
/// does not abort: the deadline is effectively unreachable.
#[test]
fun timeout_helpers_no_overflow_on_huge_last_activity() {
    let mut ctx = sui::tx_context::dummy();
    let config = referee::create_timeout_config(ONE_HOUR_MS);
    let huge = u64_max() - 10; // last_activity + timeout would overflow u64

    let c = clock_at(ONE_HOUR_MS, &mut ctx);
    // Deadline far in the future -> not reached, full time remaining, no elapsed.
    assert!(!referee::is_timeout_reached(&config, huge, &c));
    assert!(!referee::is_timeout_with_grace_reached(&config, huge, &c));
    assert_eq!(referee::time_since_timeout(&config, huge, &c), 0);
    assert!(referee::time_until_timeout(&config, huge, &c) > 0);
    // Penalty depends on elapsed == 0 -> zero, no abort.
    let pen_config = referee::create_penalty_config(ONE_HOUR_MS, 1000, 500, 5000);
    assert_eq!(referee::calculate_penalty(&pen_config, huge, &c), 0);
    destroy(c);
}

/// `create_dispute` saturates the response deadline at `u64::MAX` instead of
/// overflowing when `now + timeout_ms` exceeds u64.
#[test]
fun create_dispute_saturates_deadline() {
    let mut scenario = test_scenario::begin(@0x1);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(u64_max() - 5); // now near u64::MAX
    let config = referee::create_timeout_config(ONE_HOUR_MS);

    let dispute = referee::create_dispute(
        7,
        @0x2,
        referee::violation_no_response(),
        b"e",
        0,
        &config,
        &clock,
        scenario.ctx(),
    );

    // now + 1h overflows u64 -> deadline saturated to u64::MAX.
    assert_eq!(referee::dispute_response_deadline(&dispute), u64_max());

    clock::destroy_for_testing(clock);
    scenario.end();
}

/// Largest u64 value, mirroring `std::u64::max_value!()` used in the source.
fun u64_max(): u64 {
    18446744073709551615
}
