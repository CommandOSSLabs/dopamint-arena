#[test_only]
module sui_tunnel::example_escrow_tests;

use std::unit_test::assert_eq;
use sui::sui::SUI;
use sui_tunnel::example_escrow;

#[test]
fun status_constants() {
    assert_eq!(example_escrow::status_created(), 0);
    assert_eq!(example_escrow::status_funded(), 1);
    assert_eq!(example_escrow::status_delivered(), 2);
    assert_eq!(example_escrow::status_disputed(), 3);
    assert_eq!(example_escrow::status_completed(), 4);
    assert_eq!(example_escrow::status_refunded(), 5);
    assert_eq!(example_escrow::status_cancelled(), 6);
}

#[test]
fun default_windows() {
    // 7 days in ms
    assert_eq!(example_escrow::default_dispute_window_ms(), 604800000);
    // 30 days in ms
    assert_eq!(example_escrow::auto_release_window_ms(), 2592000000);
}

/// Test: Cannot cancel escrow after it has been completed
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_escrow::EInvalidState,
        location = sui_tunnel::example_escrow,
    ),
]
fun cancel_escrow_after_completion() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let payment = sui::coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut escrow = example_escrow::create_escrow<SUI>(
        @0xBBBB,
        b"test goods",
        payment,
        0,
        &clock,
        &mut ctx,
    );

    // Buyer (@0x0) confirms and releases funds (funds transferred to seller internally)
    let _receipt = example_escrow::confirm_and_release<SUI>(&mut escrow, &clock, &mut ctx);

    // Now status is COMPLETED, cancel should fail with invalid_state
    example_escrow::cancel_escrow<SUI>(&mut escrow, &mut ctx);

    std::unit_test::destroy(escrow);
    clock.destroy_for_testing();
}

/// Test: Wrong party cannot mark delivery (buyer tries instead of seller)
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_escrow::ENotAuthorized,
        location = sui_tunnel::example_escrow,
    ),
]
fun wrong_party_marks_delivered() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let payment = sui::coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut escrow = example_escrow::create_escrow<SUI>(
        @0xBBBB,
        b"test goods",
        payment,
        0,
        &clock,
        &mut ctx,
    );

    // sender is @0x0 (buyer), but mark_delivered requires seller (@0xBBBB) -> not_authorized
    example_escrow::mark_delivered<SUI>(&mut escrow, &clock, &ctx);

    std::unit_test::destroy(escrow);
    clock.destroy_for_testing();
}

/// Test: Cannot create escrow with zero amount
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_escrow::EInvalidDepositAmount,
        location = sui_tunnel::example_escrow,
    ),
]
fun escrow_zero_amount() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let payment = sui::coin::mint_for_testing<SUI>(0, &mut ctx);
    let escrow = example_escrow::create_escrow<SUI>(@0xBBBB, b"test", payment, 0, &clock, &mut ctx);

    std::unit_test::destroy(escrow);
    clock.destroy_for_testing();
}

/// Test: Cannot create escrow where buyer == seller
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_escrow::EInvalidParties,
        location = sui_tunnel::example_escrow,
    ),
]
fun escrow_same_buyer_seller() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let payment = sui::coin::mint_for_testing<SUI>(1000, &mut ctx);
    // sender is @0x0 and seller is also @0x0 -> invalid_parties
    let escrow = example_escrow::create_escrow<SUI>(@0x0, b"test", payment, 0, &clock, &mut ctx);

    std::unit_test::destroy(escrow);
    clock.destroy_for_testing();
}

/// Test: Only seller can issue refund (buyer cannot call refund_buyer)
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_escrow::ENotAuthorized,
        location = sui_tunnel::example_escrow,
    ),
]
fun buyer_cannot_refund() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    // buyer is @0x0 (sender), seller is @0xBBBB
    let payment = sui::coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut escrow = example_escrow::create_escrow<SUI>(
        @0xBBBB,
        b"test goods",
        payment,
        0,
        &clock,
        &mut ctx,
    );

    // refund_buyer requires ctx.sender() == escrow.seller (@0xBBBB),
    // but sender is @0x0 (buyer) -> not_authorized
    example_escrow::refund_buyer<SUI>(&mut escrow, &mut ctx);

    std::unit_test::destroy(escrow);
    clock.destroy_for_testing();
}

/// Test: Cannot raise dispute when escrow is in FUNDED status (requires DELIVERED)
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_escrow::EInvalidState,
        location = sui_tunnel::example_escrow,
    ),
]
fun dispute_before_delivery() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let payment = sui::coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut escrow = example_escrow::create_escrow<SUI>(
        @0xBBBB,
        b"test goods",
        payment,
        0,
        &clock,
        &mut ctx,
    );

    // Escrow is FUNDED, not DELIVERED -> raise_dispute requires DELIVERED -> invalid_state
    example_escrow::raise_dispute<SUI>(&mut escrow, b"dispute reason", &clock, &ctx);

    std::unit_test::destroy(escrow);
    clock.destroy_for_testing();
}
