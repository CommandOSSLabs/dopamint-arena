#[test_only]
module sui_tunnel::example_api_credits_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui_tunnel::example_api_credits;

#[test]
fun status_constants() {
    assert_eq!(example_api_credits::session_active(), 0);
    assert_eq!(example_api_credits::session_closed(), 1);
    assert_eq!(example_api_credits::session_disputed(), 2);
    assert_eq!(example_api_credits::session_force_closed(), 3);
    assert_eq!(example_api_credits::default_timeout_ms(), 3600000);
}

#[test]
fun open_session() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let session = example_api_credits::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        10, // 10 per call
        0, // unlimited calls
        &clock,
        &mut ctx,
    );

    assert_eq!(example_api_credits::session_status<SUI>(&session), 0);
    assert_eq!(example_api_credits::session_total_calls<SUI>(&session), 0);
    assert_eq!(example_api_credits::session_total_cost<SUI>(&session), 0);
    assert_eq!(example_api_credits::session_price_per_call<SUI>(&session), 10);
    assert_eq!(example_api_credits::session_max_calls<SUI>(&session), 0);
    assert_eq!(example_api_credits::session_nonce<SUI>(&session), 0);

    example_api_credits::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun session_balance_after_open() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let session = example_api_credits::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        10,
        0,
        &clock,
        &mut ctx,
    );

    // Verify client deposit is tracked
    assert_eq!(example_api_credits::session_total_balance<SUI>(&session), 10000);

    example_api_credits::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun record_usage() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_api_credits::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        10,
        0,
        &clock,
        &mut ctx,
    );

    // Record 5 API calls (cost = 5 * 10 = 50)
    example_api_credits::record_usage<SUI>(
        &mut session,
        5, // total_calls
        50, // total_cost
        1, // nonce
        9950, // party_a_balance (10000 - 50)
        50, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    assert_eq!(example_api_credits::session_total_calls<SUI>(&session), 5);
    assert_eq!(example_api_credits::session_total_cost<SUI>(&session), 50);
    assert_eq!(example_api_credits::session_nonce<SUI>(&session), 1);

    // Record 15 more calls (total 20, cost = 200)
    example_api_credits::record_usage<SUI>(
        &mut session,
        20,
        200,
        2,
        9800, // party_a_balance (10000 - 200)
        200, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    assert_eq!(example_api_credits::session_total_calls<SUI>(&session), 20);
    assert_eq!(example_api_credits::session_total_cost<SUI>(&session), 200);

    example_api_credits::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun record_usage_with_max_calls() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_api_credits::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        10,
        100, // max 100 calls
        &clock,
        &mut ctx,
    );

    // Record 100 calls (at the limit)
    example_api_credits::record_usage<SUI>(
        &mut session,
        100,
        1000,
        1,
        9000, // party_a_balance (10000 - 1000)
        1000, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    assert_eq!(example_api_credits::session_total_calls<SUI>(&session), 100);

    example_api_credits::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_api_credits::EOverflow,
        location = sui_tunnel::example_api_credits,
    ),
]
fun record_usage_exceeds_max_calls() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_api_credits::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        10,
        50, // max 50 calls
        &clock,
        &mut ctx,
    );

    // Try to record 51 calls (exceeds max)
    example_api_credits::record_usage<SUI>(
        &mut session,
        51,
        510,
        1,
        9490, // party_a_balance (10000 - 510)
        510, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    example_api_credits::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_api_credits::EBalanceMismatch,
        location = sui_tunnel::example_api_credits,
    ),
]
fun record_usage_wrong_cost() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_api_credits::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        10,
        0,
        &clock,
        &mut ctx,
    );

    // Wrong cost: 5 calls at 10 per call should be 50, not 100
    example_api_credits::record_usage<SUI>(
        &mut session,
        5,
        100, // wrong!
        1,
        9900, // party_a_balance (10000 - 100)
        100, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    example_api_credits::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_api_credits::EInsufficientBalance,
        location = sui_tunnel::example_api_credits,
    ),
]
fun record_usage_exceeds_budget() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(100, &mut ctx);

    let mut session = example_api_credits::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        10,
        0,
        &clock,
        &mut ctx,
    );

    // 20 calls * 10 = 200, but budget is only 100
    example_api_credits::record_usage<SUI>(
        &mut session,
        20,
        200,
        1,
        0, // party_a_balance (budget exhausted)
        200, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    example_api_credits::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_api_credits::EInvalidNonce,
        location = sui_tunnel::example_api_credits,
    ),
]
fun record_usage_stale_nonce() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_api_credits::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        10,
        0,
        &clock,
        &mut ctx,
    );

    example_api_credits::record_usage<SUI>(
        &mut session,
        5,
        50,
        1,
        9950, // party_a_balance (10000 - 50)
        50, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    // Stale nonce (0 <= 1)
    example_api_credits::record_usage<SUI>(
        &mut session,
        10,
        100,
        0,
        9900, // party_a_balance (10000 - 100)
        100, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    example_api_credits::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_api_credits::EInvalidState,
        location = sui_tunnel::example_api_credits,
    ),
]
fun cannot_record_usage_when_closed() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_api_credits::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        10,
        0,
        &clock,
        &mut ctx,
    );

    example_api_credits::set_status_for_testing<SUI>(
        &mut session,
        example_api_credits::session_closed(),
    );

    example_api_credits::record_usage<SUI>(
        &mut session,
        5,
        50,
        1,
        9950, // party_a_balance (10000 - 50)
        50, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    example_api_credits::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun calculate_settlement() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_api_credits::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        10,
        0,
        &clock,
        &mut ctx,
    );

    example_api_credits::record_usage<SUI>(
        &mut session,
        50,
        500,
        1,
        9500, // party_a_balance (10000 - 500)
        500, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    let (client_refund, provider_earned) = example_api_credits::calculate_settlement<SUI>(&session);
    assert_eq!(client_refund, 9500);
    assert_eq!(provider_earned, 500);

    example_api_credits::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun compute_usage_hash_deterministic() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let session = example_api_credits::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        10,
        0,
        &clock,
        &mut ctx,
    );

    let hash1 = example_api_credits::compute_usage_hash<SUI>(&session, 5, 50, 1);
    let hash2 = example_api_credits::compute_usage_hash<SUI>(&session, 5, 50, 1);
    assert_eq!(hash1, hash2);

    let hash3 = example_api_credits::compute_usage_hash<SUI>(&session, 10, 100, 1);
    assert!(hash1 != hash3);
    assert_eq!(hash1.length(), 32);

    example_api_credits::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun usage_state_accessors() {
    let state = example_api_credits::create_usage_state_for_testing(42, 420, 7);
    assert_eq!(example_api_credits::usage_total_calls(&state), 42);
    assert_eq!(example_api_credits::usage_total_cost(&state), 420);
    assert_eq!(example_api_credits::usage_nonce(&state), 7);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_api_credits::EInvalidParameter,
        location = sui_tunnel::example_api_credits,
    ),
]
fun open_session_zero_price() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let session = example_api_credits::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        0,
        0,
        &clock,
        &mut ctx,
    );

    example_api_credits::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}
