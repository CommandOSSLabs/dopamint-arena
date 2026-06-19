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

    assert_eq!(session.session_status<SUI>(), 0);
    assert_eq!(session.session_total_calls<SUI>(), 0);
    assert_eq!(session.session_total_cost<SUI>(), 0);
    assert_eq!(session.session_price_per_call<SUI>(), 10);
    assert_eq!(session.session_max_calls<SUI>(), 0);
    assert_eq!(session.session_nonce<SUI>(), 0);

    session.destroy_session_for_testing<SUI>();
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
    assert_eq!(session.session_total_balance<SUI>(), 10000);

    session.destroy_session_for_testing<SUI>();
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
    session.record_usage<SUI>(
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

    assert_eq!(session.session_total_calls<SUI>(), 5);
    assert_eq!(session.session_total_cost<SUI>(), 50);
    assert_eq!(session.session_nonce<SUI>(), 1);

    // Record 15 more calls (total 20, cost = 200)
    session.record_usage<SUI>(
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

    assert_eq!(session.session_total_calls<SUI>(), 20);
    assert_eq!(session.session_total_cost<SUI>(), 200);

    session.destroy_session_for_testing<SUI>();
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
    session.record_usage<SUI>(
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

    assert_eq!(session.session_total_calls<SUI>(), 100);

    session.destroy_session_for_testing<SUI>();
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
    session.record_usage<SUI>(
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

    session.destroy_session_for_testing<SUI>();
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
    session.record_usage<SUI>(
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

    session.destroy_session_for_testing<SUI>();
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
    session.record_usage<SUI>(
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

    session.destroy_session_for_testing<SUI>();
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

    session.record_usage<SUI>(
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
    session.record_usage<SUI>(
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

    session.destroy_session_for_testing<SUI>();
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

    session.set_status_for_testing<SUI>(
        example_api_credits::session_closed(),
    );

    session.record_usage<SUI>(
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

    session.destroy_session_for_testing<SUI>();
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

    session.record_usage<SUI>(
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

    let (client_refund, provider_earned) = session.calculate_settlement<SUI>();
    assert_eq!(client_refund, 9500);
    assert_eq!(provider_earned, 500);

    session.destroy_session_for_testing<SUI>();
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

    let hash1 = session.compute_usage_hash<SUI>(5, 50, 1);
    let hash2 = session.compute_usage_hash<SUI>(5, 50, 1);
    assert_eq!(hash1, hash2);

    let hash3 = session.compute_usage_hash<SUI>(10, 100, 1);
    assert!(hash1 != hash3);
    assert_eq!(hash1.length(), 32);

    session.destroy_session_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

#[test]
fun usage_state_accessors() {
    let state = example_api_credits::create_usage_state_for_testing(42, 420, 7);
    assert_eq!(state.usage_total_calls(), 42);
    assert_eq!(state.usage_total_cost(), 420);
    assert_eq!(state.usage_nonce(), 7);
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

    session.destroy_session_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}
