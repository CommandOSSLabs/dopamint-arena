#[test_only]
module sui_tunnel::example_token_billing_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui_tunnel::example_token_billing;

#[test]
fun status_constants() {
    assert_eq!(example_token_billing::session_active(), 0);
    assert_eq!(example_token_billing::session_closed(), 1);
    assert_eq!(example_token_billing::session_disputed(), 2);
    assert_eq!(example_token_billing::session_force_closed(), 3);
    assert_eq!(example_token_billing::default_timeout_ms(), 3600000);
}

#[test]
fun open_session() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1, // prompt price
        3, // completion price
        0, // unlimited tokens
        &clock,
        &mut ctx,
    );

    assert_eq!(example_token_billing::session_status<SUI>(&session), 0);
    assert_eq!(example_token_billing::session_total_prompt_tokens<SUI>(&session), 0);
    assert_eq!(example_token_billing::session_total_completion_tokens<SUI>(&session), 0);
    assert_eq!(example_token_billing::session_total_cost<SUI>(&session), 0);
    assert_eq!(example_token_billing::session_prompt_price<SUI>(&session), 1);
    assert_eq!(example_token_billing::session_completion_price<SUI>(&session), 3);
    assert_eq!(example_token_billing::session_max_tokens<SUI>(&session), 0);
    assert_eq!(example_token_billing::session_nonce<SUI>(&session), 0);

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun session_balance_after_open() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        &mut ctx,
    );

    // Verify client deposit is tracked
    assert_eq!(example_token_billing::session_total_balance<SUI>(&session), 10000);

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun record_usage() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1, // prompt price
        3, // completion price
        0,
        &clock,
        &mut ctx,
    );

    // 100 prompt @ 1 + 20 completion @ 3 = 100 + 60 = 160
    example_token_billing::record_usage<SUI>(
        &mut session,
        100, // prompt_tokens
        20, // completion_tokens
        160, // total_cost
        1, // nonce
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    assert_eq!(example_token_billing::session_total_prompt_tokens<SUI>(&session), 100);
    assert_eq!(example_token_billing::session_total_completion_tokens<SUI>(&session), 20);
    assert_eq!(example_token_billing::session_total_cost<SUI>(&session), 160);
    assert_eq!(example_token_billing::session_nonce<SUI>(&session), 1);

    // 300 prompt @ 1 + 50 completion @ 3 = 300 + 150 = 450
    example_token_billing::record_usage<SUI>(
        &mut session,
        300,
        50,
        450,
        2,
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    assert_eq!(example_token_billing::session_total_prompt_tokens<SUI>(&session), 300);
    assert_eq!(example_token_billing::session_total_completion_tokens<SUI>(&session), 50);
    assert_eq!(example_token_billing::session_total_cost<SUI>(&session), 450);

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun record_usage_with_max_tokens() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        120, // max 120 tokens total
        &clock,
        &mut ctx,
    );

    // 100 prompt + 20 completion = 120 tokens (at the cap)
    example_token_billing::record_usage<SUI>(
        &mut session,
        100,
        20,
        160, // 100 * 1 + 20 * 3
        1,
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    assert_eq!(example_token_billing::session_total_prompt_tokens<SUI>(&session), 100);
    assert_eq!(example_token_billing::session_total_completion_tokens<SUI>(&session), 20);

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_token_billing::ETokenLimitExceeded,
        location = sui_tunnel::example_token_billing,
    ),
]
fun record_usage_exceeds_max_tokens() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        100, // max 100 tokens total
        &clock,
        &mut ctx,
    );

    // 100 prompt + 20 completion = 120 tokens (exceeds max of 100)
    example_token_billing::record_usage<SUI>(
        &mut session,
        100,
        20,
        160, // 100 * 1 + 20 * 3
        1,
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_token_billing::EBalanceMismatch,
        location = sui_tunnel::example_token_billing,
    ),
]
fun record_usage_wrong_cost() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        &mut ctx,
    );

    // Wrong cost: 100 prompt @ 1 + 20 completion @ 3 should be 160, not 200
    example_token_billing::record_usage<SUI>(
        &mut session,
        100,
        20,
        200, // wrong!
        1,
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_token_billing::EInsufficientBalance,
        location = sui_tunnel::example_token_billing,
    ),
]
fun record_usage_exceeds_budget() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(100, &mut ctx);

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        &mut ctx,
    );

    // 100 prompt @ 1 + 20 completion @ 3 = 160, but budget is only 100
    example_token_billing::record_usage<SUI>(
        &mut session,
        100,
        20,
        160,
        1,
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_token_billing::EStaleState,
        location = sui_tunnel::example_token_billing,
    ),
]
fun record_usage_regressing_total_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        &mut ctx,
    );

    example_token_billing::record_usage<SUI>(
        &mut session,
        100,
        20,
        160,
        1,
        0,
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    // A higher nonce but a regressed token total is a stale snapshot: reject it.
    example_token_billing::record_usage<SUI>(
        &mut session,
        50,
        20,
        110,
        2,
        0,
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_token_billing::EInvalidNonce,
        location = sui_tunnel::example_token_billing,
    ),
]
fun record_usage_stale_nonce() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        &mut ctx,
    );

    example_token_billing::record_usage<SUI>(
        &mut session,
        100,
        20,
        160,
        1,
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    // Stale nonce (0 <= 1)
    example_token_billing::record_usage<SUI>(
        &mut session,
        200,
        40,
        320,
        0,
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_token_billing::EInvalidState,
        location = sui_tunnel::example_token_billing,
    ),
]
fun cannot_record_usage_when_closed() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        &mut ctx,
    );

    example_token_billing::set_status_for_testing<SUI>(
        &mut session,
        example_token_billing::session_closed(),
    );

    example_token_billing::record_usage<SUI>(
        &mut session,
        100,
        20,
        160,
        1,
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun calculate_settlement() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        &mut ctx,
    );

    // 500 prompt @ 1 + 100 completion @ 3 = 500 + 300 = 800
    example_token_billing::record_usage<SUI>(
        &mut session,
        500,
        100,
        800,
        1,
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    let (client_refund, provider_earned) = example_token_billing::calculate_settlement<SUI>(
        &session,
    );
    assert_eq!(client_refund, 9200);
    assert_eq!(provider_earned, 800);

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun compute_usage_hash_deterministic() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        &mut ctx,
    );

    let hash1 = example_token_billing::compute_usage_hash<SUI>(&session, 100, 20, 160, 1);
    let hash2 = example_token_billing::compute_usage_hash<SUI>(&session, 100, 20, 160, 1);
    assert_eq!(hash1, hash2);

    let hash3 = example_token_billing::compute_usage_hash<SUI>(&session, 200, 40, 320, 1);
    assert!(hash1 != hash3);
    assert_eq!(hash1.length(), 32);

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun usage_state_accessors() {
    let state = example_token_billing::create_usage_state_for_testing(100, 20, 160, 7);
    assert_eq!(example_token_billing::usage_prompt_tokens(&state), 100);
    assert_eq!(example_token_billing::usage_completion_tokens(&state), 20);
    assert_eq!(example_token_billing::usage_total_cost(&state), 160);
    assert_eq!(example_token_billing::usage_nonce(&state), 7);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_token_billing::EInvalidParameter,
        location = sui_tunnel::example_token_billing,
    ),
]
fun open_session_zero_price() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        0, // zero prompt price
        3,
        0,
        &clock,
        &mut ctx,
    );

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun join_as_provider() {
    // The provider deposit_party_b requires the provider's own address as sender,
    // so the join runs in a second tx sent by @0x2.
    let mut scenario = sui::test_scenario::begin(@0x0);
    let clock = clock::create_for_testing(scenario.ctx());
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(@0x2);
    let collateral = coin::mint_for_testing<SUI>(500, scenario.ctx());
    example_token_billing::join_as_provider<SUI>(&mut session, collateral, &clock, scenario.ctx());

    assert_eq!(example_token_billing::session_total_balance<SUI>(&session), 10500);

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_token_billing::EBalanceMismatch,
        location = sui_tunnel::example_token_billing,
    ),
]
fun close_session_balance_mismatch() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        &mut ctx,
    );

    // calculate_settlement yields (10000, 0); this split does not match.
    example_token_billing::close_session<SUI>(
        &mut session,
        9000,
        1000,
        vector[],
        vector[],
        0,
        &clock,
        &mut ctx,
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_token_billing::ENoActiveDispute,
        location = sui_tunnel::example_token_billing,
    ),
]
fun force_close_without_dispute() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        &mut ctx,
    );

    example_token_billing::force_close<SUI>(&mut session, &clock, &mut ctx);

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_token_billing::EInvalidParameter,
        location = sui_tunnel::example_token_billing,
    ),
]
fun open_session_zero_completion_price() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        0, // zero completion price
        0,
        &clock,
        &mut ctx,
    );

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_token_billing::EOverflow,
        location = sui_tunnel::example_token_billing,
    ),
]
fun record_usage_completion_product_overflow() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1, // prompt price
        18446744073709551615, // completion price = u64 max
        0,
        &clock,
        &mut ctx,
    );

    // completion_tokens * completion_price overflows: 2 * u64_max.
    example_token_billing::record_usage<SUI>(
        &mut session,
        1, // prompt_tokens
        2, // completion_tokens
        0, // total_cost (never validated; overflow guard fires first)
        1, // nonce (must exceed the initial 0)
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_token_billing::EOverflow,
        location = sui_tunnel::example_token_billing,
    ),
]
fun record_usage_cost_sum_overflow() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        18446744073709551615, // prompt price = u64 max
        1, // completion price
        0,
        &clock,
        &mut ctx,
    );

    // prompt_cost (u64 max) + completion_cost (1) overflows the sum.
    example_token_billing::record_usage<SUI>(
        &mut session,
        1, // prompt_tokens
        1, // completion_tokens
        0, // total_cost (never validated; overflow guard fires first)
        1, // nonce (must exceed the initial 0)
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_token_billing::ENotAuthorized,
        location = sui_tunnel::example_token_billing,
    ),
]
fun record_usage_rejects_third_party() {
    // A sender that is neither the client (@0x0) nor the provider (@0x2) must
    // not be able to ratchet usage forward.
    let mut scenario = sui::test_scenario::begin(@0x0);
    let clock = clock::create_for_testing(scenario.ctx());
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(@0xBAD);
    example_token_billing::record_usage<SUI>(
        &mut session,
        100,
        20,
        160,
        1,
        0, // timestamp
        vector[],
        vector[],
        &clock,
        scenario.ctx(),
    );

    abort
}

#[test]
fun calculate_settlement_returns_provider_collateral() {
    // With collateral posted, settlement must return each side its own deposit:
    // the client keeps the unspent budget, the provider recovers its collateral
    // plus the metered cost, and the split conserves the full tunnel balance.
    let mut scenario = sui::test_scenario::begin(@0x0);
    let clock = clock::create_for_testing(scenario.ctx());
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(@0x2);
    let collateral = coin::mint_for_testing<SUI>(500, scenario.ctx());
    example_token_billing::join_as_provider<SUI>(&mut session, collateral, &clock, scenario.ctx());

    // 500 prompt @ 1 + 100 completion @ 3 = 800.
    example_token_billing::record_usage<SUI>(
        &mut session,
        500,
        100,
        800,
        1,
        0, // timestamp
        vector[],
        vector[],
        &clock,
        scenario.ctx(),
    );

    let (client_refund, provider_earned) = example_token_billing::calculate_settlement<SUI>(
        &session,
    );
    assert_eq!(client_refund, 9200);
    assert_eq!(provider_earned, 1300);
    assert_eq!(
        client_refund + provider_earned,
        example_token_billing::session_total_balance<SUI>(&session),
    );

    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
    scenario.end();
}

#[test]
fun cancel_session_refunds_client_before_provider_joins() {
    let mut scenario = sui::test_scenario::begin(@0x0);
    let clock = clock::create_for_testing(scenario.ctx());
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut session = example_token_billing::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1,
        3,
        0,
        &clock,
        scenario.ctx(),
    );

    let refund = example_token_billing::cancel_session<SUI>(
        &mut session,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(refund.value(), 10000);
    assert_eq!(
        example_token_billing::session_status<SUI>(&session),
        example_token_billing::session_closed(),
    );

    refund.burn_for_testing();
    example_token_billing::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
    scenario.end();
}
