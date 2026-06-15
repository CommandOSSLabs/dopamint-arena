#[test_only]
module sui_tunnel::example_tunnel_lifecycle_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui_tunnel::example_tunnel_lifecycle;

const DEFAULT_TIMEOUT_MS: u64 = 3600000;

#[test]
fun status_constants() {
    assert_eq!(example_tunnel_lifecycle::session_active(), 0);
    assert_eq!(example_tunnel_lifecycle::session_closed(), 1);
    assert_eq!(example_tunnel_lifecycle::session_disputed(), 2);
    assert_eq!(example_tunnel_lifecycle::session_force_closed(), 3);
    assert_eq!(example_tunnel_lifecycle::default_timeout_ms(), 3600000);
}

#[test]
fun calculate_final_balances_equal() {
    let (a, b) = example_tunnel_lifecycle::calculate_final_balances(1000, 1000, 0, 0);
    assert_eq!(a, 1000);
    assert_eq!(b, 1000);
}

#[test]
fun calculate_final_balances_a_pays_b() {
    let (a, b) = example_tunnel_lifecycle::calculate_final_balances(1000, 1000, 300, 0);
    assert_eq!(a, 700);
    assert_eq!(b, 1300);
}

#[test]
fun calculate_final_balances_both_pay() {
    let (a, b) = example_tunnel_lifecycle::calculate_final_balances(1000, 1000, 300, 100);
    assert_eq!(a, 800);
    assert_eq!(b, 1200);
}

#[test]
fun calculate_final_balances_full_transfer() {
    let (a, b) = example_tunnel_lifecycle::calculate_final_balances(1000, 0, 1000, 0);
    assert_eq!(a, 0);
    assert_eq!(b, 1000);
}

#[test]
fun calculate_final_balances_asymmetric_deposits() {
    let (a, b) = example_tunnel_lifecycle::calculate_final_balances(500, 1500, 200, 300);
    assert_eq!(a, 600);
    assert_eq!(b, 1400);
}

#[test]
fun build_state_commitment_deterministic() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let session = example_tunnel_lifecycle::create_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"test",
        DEFAULT_TIMEOUT_MS,
        &clock,
        &mut ctx,
    );

    let hash1 = example_tunnel_lifecycle::build_state_commitment<SUI>(&session, 100, 50, 1);
    let hash2 = example_tunnel_lifecycle::build_state_commitment<SUI>(&session, 100, 50, 1);
    assert_eq!(hash1, hash2);

    let hash3 = example_tunnel_lifecycle::build_state_commitment<SUI>(&session, 200, 50, 1);
    assert!(hash1 != hash3);
    assert_eq!(hash1.length(), 32);

    example_tunnel_lifecycle::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun create_session_and_accessors() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let session = example_tunnel_lifecycle::create_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"test session",
        DEFAULT_TIMEOUT_MS,
        &clock,
        &mut ctx,
    );

    assert_eq!(example_tunnel_lifecycle::session_status<SUI>(&session), 0);
    assert_eq!(example_tunnel_lifecycle::session_nonce<SUI>(&session), 0);
    assert_eq!(
        example_tunnel_lifecycle::state_total_a_to_b(
            example_tunnel_lifecycle::session_latest_state<SUI>(&session),
        ),
        0,
    );
    assert_eq!(
        example_tunnel_lifecycle::state_total_b_to_a(
            example_tunnel_lifecycle::session_latest_state<SUI>(&session),
        ),
        0,
    );
    assert_eq!(
        *example_tunnel_lifecycle::state_memo(
            example_tunnel_lifecycle::session_latest_state<SUI>(&session),
        ),
        b"test session",
    );

    example_tunnel_lifecycle::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun record_state_update() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let mut session = example_tunnel_lifecycle::create_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"test",
        DEFAULT_TIMEOUT_MS,
        &clock,
        &mut ctx,
    );

    clock::increment_for_testing(&mut clock, 1000);
    example_tunnel_lifecycle::record_state_update<SUI>(
        &mut session,
        100,
        0,
        1,
        900,
        100,
        0,
        vector[],
        vector[],
        &clock,
    );
    assert_eq!(example_tunnel_lifecycle::session_nonce<SUI>(&session), 1);
    assert_eq!(
        example_tunnel_lifecycle::state_total_a_to_b(
            example_tunnel_lifecycle::session_latest_state<SUI>(&session),
        ),
        100,
    );

    clock::increment_for_testing(&mut clock, 1000);
    example_tunnel_lifecycle::record_state_update<SUI>(
        &mut session,
        200,
        50,
        2,
        850,
        150,
        0,
        vector[],
        vector[],
        &clock,
    );
    assert_eq!(example_tunnel_lifecycle::session_nonce<SUI>(&session), 2);
    assert_eq!(
        example_tunnel_lifecycle::state_total_a_to_b(
            example_tunnel_lifecycle::session_latest_state<SUI>(&session),
        ),
        200,
    );
    assert_eq!(
        example_tunnel_lifecycle::state_total_b_to_a(
            example_tunnel_lifecycle::session_latest_state<SUI>(&session),
        ),
        50,
    );

    example_tunnel_lifecycle::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_tunnel_lifecycle::EInvalidNonce,
        location = sui_tunnel::example_tunnel_lifecycle,
    ),
]
fun record_state_update_stale_nonce() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let mut session = example_tunnel_lifecycle::create_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"test",
        DEFAULT_TIMEOUT_MS,
        &clock,
        &mut ctx,
    );

    example_tunnel_lifecycle::record_state_update<SUI>(
        &mut session,
        100,
        0,
        1,
        900,
        100,
        0,
        vector[],
        vector[],
        &clock,
    );
    // Try to record with nonce 0 (stale) - should fail
    example_tunnel_lifecycle::record_state_update<SUI>(
        &mut session,
        200,
        0,
        0,
        800,
        200,
        0,
        vector[],
        vector[],
        &clock,
    );

    example_tunnel_lifecycle::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun multiple_state_updates_preserve_memo() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let mut session = example_tunnel_lifecycle::create_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"original memo",
        DEFAULT_TIMEOUT_MS,
        &clock,
        &mut ctx,
    );

    clock::increment_for_testing(&mut clock, 1000);
    example_tunnel_lifecycle::record_state_update<SUI>(
        &mut session,
        100,
        0,
        1,
        900,
        100,
        0,
        vector[],
        vector[],
        &clock,
    );
    assert_eq!(
        *example_tunnel_lifecycle::state_memo(
            example_tunnel_lifecycle::session_latest_state<SUI>(&session),
        ),
        b"original memo",
    );

    clock::increment_for_testing(&mut clock, 1000);
    example_tunnel_lifecycle::record_state_update<SUI>(
        &mut session,
        200,
        50,
        2,
        850,
        150,
        0,
        vector[],
        vector[],
        &clock,
    );
    assert_eq!(
        *example_tunnel_lifecycle::state_memo(
            example_tunnel_lifecycle::session_latest_state<SUI>(&session),
        ),
        b"original memo",
    );

    example_tunnel_lifecycle::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[test]
fun micropayment_state_accessors() {
    let state = example_tunnel_lifecycle::create_micropayment_state_for_testing(
        500,
        200,
        42,
        b"payment for service",
    );

    assert_eq!(example_tunnel_lifecycle::state_total_a_to_b(&state), 500);
    assert_eq!(example_tunnel_lifecycle::state_total_b_to_a(&state), 200);
    assert_eq!(example_tunnel_lifecycle::state_nonce(&state), 42);
    assert_eq!(*example_tunnel_lifecycle::state_memo(&state), b"payment for service");
}

#[test]
fun session_receipt_accessors() {
    let mut ctx = sui::tx_context::dummy();
    let receipt = example_tunnel_lifecycle::create_session_receipt_for_testing(
        800,
        1200,
        10,
        example_tunnel_lifecycle::session_closed(),
        &mut ctx,
    );

    assert_eq!(example_tunnel_lifecycle::receipt_party_a_received(&receipt), 800);
    assert_eq!(example_tunnel_lifecycle::receipt_party_b_received(&receipt), 1200);
    assert_eq!(example_tunnel_lifecycle::receipt_final_nonce(&receipt), 10);
    assert_eq!(
        example_tunnel_lifecycle::receipt_close_method(&receipt),
        example_tunnel_lifecycle::session_closed(),
    );

    example_tunnel_lifecycle::destroy_receipt_for_testing(receipt);
}

#[test]
fun rate_limited_updates() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";

    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let mut session = example_tunnel_lifecycle::create_session_with_rate_limit_for_testing<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"rate limited",
        DEFAULT_TIMEOUT_MS,
        5000,
        &clock,
        &mut ctx,
    );

    // First update should succeed
    clock::increment_for_testing(&mut clock, 5000);
    example_tunnel_lifecycle::record_state_update<SUI>(
        &mut session,
        100,
        0,
        1,
        900,
        100,
        0,
        vector[],
        vector[],
        &clock,
    );

    // After 5 more seconds, should succeed again
    clock::increment_for_testing(&mut clock, 5000);
    example_tunnel_lifecycle::record_state_update<SUI>(
        &mut session,
        200,
        0,
        2,
        800,
        200,
        0,
        vector[],
        vector[],
        &clock,
    );

    example_tunnel_lifecycle::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_tunnel_lifecycle::EInvalidState,
        location = sui_tunnel::example_tunnel_lifecycle,
    ),
]
fun rate_limit_too_fast() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";

    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let mut session = example_tunnel_lifecycle::create_session_with_rate_limit_for_testing<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"rate limited",
        DEFAULT_TIMEOUT_MS,
        5000,
        &clock,
        &mut ctx,
    );

    // First update at 5s
    clock::increment_for_testing(&mut clock, 5000);
    example_tunnel_lifecycle::record_state_update<SUI>(
        &mut session,
        100,
        0,
        1,
        900,
        100,
        0,
        vector[],
        vector[],
        &clock,
    );

    // Try to update again too quickly (only 1s later, need 5s)
    clock::increment_for_testing(&mut clock, 1000);
    example_tunnel_lifecycle::record_state_update<SUI>(
        &mut session,
        200,
        0,
        2,
        800,
        200,
        0,
        vector[],
        vector[],
        &clock,
    );

    example_tunnel_lifecycle::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_tunnel_lifecycle::EInvalidState,
        location = sui_tunnel::example_tunnel_lifecycle,
    ),
]
fun cannot_update_closed_session() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";

    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let mut session = example_tunnel_lifecycle::create_session<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"test",
        DEFAULT_TIMEOUT_MS,
        &clock,
        &mut ctx,
    );

    // Manually close the session
    example_tunnel_lifecycle::set_status_for_testing<SUI>(
        &mut session,
        example_tunnel_lifecycle::session_closed(),
    );

    // Try to record update - should fail
    example_tunnel_lifecycle::record_state_update<SUI>(
        &mut session,
        100,
        0,
        1,
        900,
        100,
        0,
        vector[],
        vector[],
        &clock,
    );

    example_tunnel_lifecycle::destroy_session_for_testing<SUI>(session);
    clock::destroy_for_testing(clock);
}
