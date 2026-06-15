#[test_only]
module sui_tunnel::example_bandwidth_market_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui_tunnel::example_bandwidth_market;

#[test]
fun status_constants() {
    assert_eq!(example_bandwidth_market::session_active(), 0);
    assert_eq!(example_bandwidth_market::session_closed(), 1);
    assert_eq!(example_bandwidth_market::session_disputed(), 2);
    assert_eq!(example_bandwidth_market::session_force_closed(), 3);
    assert_eq!(example_bandwidth_market::bytes_per_mb(), 1048576);
}

#[test]
fun open_session() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(100000, &mut ctx);

    let session = example_bandwidth_market::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1000,
        &clock,
        &mut ctx,
    );

    assert_eq!(example_bandwidth_market::session_status<SUI>(&session), 0);
    assert_eq!(example_bandwidth_market::session_total_bytes<SUI>(&session), 0);
    assert_eq!(example_bandwidth_market::session_total_cost<SUI>(&session), 0);
    assert_eq!(example_bandwidth_market::session_rate_per_mb<SUI>(&session), 1000);
    assert_eq!(example_bandwidth_market::session_readings_count<SUI>(&session), 0);
    assert_eq!(example_bandwidth_market::session_nonce<SUI>(&session), 0);

    example_bandwidth_market::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun session_balance_after_open() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(100000, &mut ctx);

    let session = example_bandwidth_market::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1000,
        &clock,
        &mut ctx,
    );

    assert_eq!(example_bandwidth_market::session_total_balance<SUI>(&session), 100000);

    example_bandwidth_market::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun calculate_cost() {
    // 1 MB at 1000 per MB = 1000
    let cost = example_bandwidth_market::calculate_cost(1048576, 1000);
    assert_eq!(cost, 1000);

    // 2 MB at 1000 per MB = 2000
    let cost2 = example_bandwidth_market::calculate_cost(2097152, 1000);
    assert_eq!(cost2, 2000);

    // 0.5 MB at 1000 per MB = 500
    let cost3 = example_bandwidth_market::calculate_cost(524288, 1000);
    assert_eq!(cost3, 500);

    // 0 bytes = 0 cost
    let cost4 = example_bandwidth_market::calculate_cost(0, 1000);
    assert_eq!(cost4, 0);
}

#[test]
fun record_reading() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(100000, &mut ctx);

    let mut session = example_bandwidth_market::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1000,
        &clock,
        &mut ctx,
    );

    // 1 MB consumed, cost = 1000
    example_bandwidth_market::record_reading<SUI>(
        &mut session,
        1048576, // 1 MB
        1000, // cost
        1, // readings_count
        1, // nonce
        99000, // party_a_balance (100000 - 1000)
        1000, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    assert_eq!(example_bandwidth_market::session_total_bytes<SUI>(&session), 1048576);
    assert_eq!(example_bandwidth_market::session_total_cost<SUI>(&session), 1000);
    assert_eq!(example_bandwidth_market::session_readings_count<SUI>(&session), 1);

    // 5 MB total consumed, cost = 5000
    example_bandwidth_market::record_reading<SUI>(
        &mut session,
        5242880, // 5 MB
        5000, // cost
        5, // readings_count (5 readings total)
        2, // nonce
        95000, // party_a_balance (100000 - 5000)
        5000, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    assert_eq!(example_bandwidth_market::session_total_bytes<SUI>(&session), 5242880);
    assert_eq!(example_bandwidth_market::session_total_cost<SUI>(&session), 5000);
    assert_eq!(example_bandwidth_market::session_readings_count<SUI>(&session), 5);

    example_bandwidth_market::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_bandwidth_market::EBalanceMismatch,
        location = sui_tunnel::example_bandwidth_market,
    ),
]
fun record_reading_wrong_cost() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(100000, &mut ctx);

    let mut session = example_bandwidth_market::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1000,
        &clock,
        &mut ctx,
    );

    // 1 MB at 1000/MB should cost 1000, not 2000
    example_bandwidth_market::record_reading<SUI>(
        &mut session,
        1048576,
        2000,
        1,
        1,
        98000, // party_a_balance (100000 - 2000)
        2000, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    example_bandwidth_market::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_bandwidth_market::EInsufficientBalance,
        location = sui_tunnel::example_bandwidth_market,
    ),
]
fun record_reading_exceeds_budget() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(500, &mut ctx);

    let mut session = example_bandwidth_market::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1000,
        &clock,
        &mut ctx,
    );

    // 1 MB costs 1000 but budget is only 500
    example_bandwidth_market::record_reading<SUI>(
        &mut session,
        1048576,
        1000,
        1,
        1,
        0, // party_a_balance (would underflow, but aborts before use)
        500, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    example_bandwidth_market::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_bandwidth_market::EInvalidNonce,
        location = sui_tunnel::example_bandwidth_market,
    ),
]
fun record_reading_stale_nonce() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(100000, &mut ctx);

    let mut session = example_bandwidth_market::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1000,
        &clock,
        &mut ctx,
    );

    example_bandwidth_market::record_reading<SUI>(
        &mut session,
        1048576,
        1000,
        1,
        1,
        99000, // party_a_balance (100000 - 1000)
        1000, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    // Stale nonce (0 <= 1)
    example_bandwidth_market::record_reading<SUI>(
        &mut session,
        2097152,
        2000,
        2,
        0,
        98000, // party_a_balance (100000 - 2000)
        2000, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    example_bandwidth_market::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_bandwidth_market::EInvalidParameter,
        location = sui_tunnel::example_bandwidth_market,
    ),
]
fun record_reading_decreasing_bytes() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(100000, &mut ctx);

    let mut session = example_bandwidth_market::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1000,
        &clock,
        &mut ctx,
    );

    example_bandwidth_market::record_reading<SUI>(
        &mut session,
        2097152,
        2000,
        1,
        1,
        98000, // party_a_balance (100000 - 2000)
        2000, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    // Bytes decreased (1MB < 2MB) - shouldn't be possible
    example_bandwidth_market::record_reading<SUI>(
        &mut session,
        1048576,
        1000,
        2,
        2,
        99000, // party_a_balance (100000 - 1000)
        1000, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    example_bandwidth_market::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun calculate_settlement() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(100000, &mut ctx);

    let mut session = example_bandwidth_market::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1000,
        &clock,
        &mut ctx,
    );

    // Used 10 MB = 10000 cost
    example_bandwidth_market::record_reading<SUI>(
        &mut session,
        10485760,
        10000,
        10,
        1,
        90000, // party_a_balance (100000 - 10000)
        10000, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    let (consumer_refund, provider_earned) = example_bandwidth_market::calculate_settlement<SUI>(
        &session,
    );
    assert_eq!(consumer_refund, 90000);
    assert_eq!(provider_earned, 10000);

    example_bandwidth_market::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun compute_meter_hash_deterministic() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(100000, &mut ctx);

    let session = example_bandwidth_market::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1000,
        &clock,
        &mut ctx,
    );

    let h1 = example_bandwidth_market::compute_meter_hash<SUI>(&session, 1048576, 1000, 1, 1);
    let h2 = example_bandwidth_market::compute_meter_hash<SUI>(&session, 1048576, 1000, 1, 1);
    assert_eq!(h1, h2);
    assert_eq!(h1.length(), 32);

    let h3 = example_bandwidth_market::compute_meter_hash<SUI>(&session, 2097152, 2000, 2, 2);
    assert!(h1 != h3);

    example_bandwidth_market::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun meter_state_accessors() {
    let state = example_bandwidth_market::create_meter_state_for_testing(
        5242880,
        5000,
        100,
        42,
    );

    assert_eq!(example_bandwidth_market::meter_total_bytes(&state), 5242880);
    assert_eq!(example_bandwidth_market::meter_total_cost(&state), 5000);
    assert_eq!(example_bandwidth_market::meter_readings_count(&state), 100);
    assert_eq!(example_bandwidth_market::meter_nonce(&state), 42);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_bandwidth_market::EInvalidParameter,
        location = sui_tunnel::example_bandwidth_market,
    ),
]
fun open_session_zero_rate() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(100000, &mut ctx);

    let session = example_bandwidth_market::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        0,
        &clock,
        &mut ctx,
    );

    example_bandwidth_market::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_bandwidth_market::EInvalidState,
        location = sui_tunnel::example_bandwidth_market,
    ),
]
fun cannot_record_reading_when_closed() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(100000, &mut ctx);

    let mut session = example_bandwidth_market::open_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        1000,
        &clock,
        &mut ctx,
    );

    example_bandwidth_market::set_status_for_testing<SUI>(
        &mut session,
        example_bandwidth_market::session_closed(),
    );

    example_bandwidth_market::record_reading<SUI>(
        &mut session,
        1048576,
        1000,
        1,
        1,
        99000, // party_a_balance (100000 - 1000)
        1000, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
    );

    example_bandwidth_market::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}
