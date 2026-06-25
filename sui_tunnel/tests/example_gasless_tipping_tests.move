#[test_only]
module sui_tunnel::example_gasless_tipping_tests;

use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui_tunnel::example_gasless_tipping;

const PK: vector<u8> = x"0000000000000000000000000000000000000000000000000000000000000001";
const REFUND_TIMEOUT_MS: u64 = 86400000;

#[test]
fun status_constants() {
    assert_eq!(example_gasless_tipping::tip_open(), 0);
    assert_eq!(example_gasless_tipping::tip_settled(), 1);
    assert_eq!(example_gasless_tipping::tip_refunded(), 2);
    assert_eq!(example_gasless_tipping::refund_timeout_ms(), REFUND_TIMEOUT_MS);
}

#[test]
fun build_tip_state_bytes_deterministic() {
    let channel_id = b"tip_channel";

    let bytes1 = example_gasless_tipping::build_tip_state_bytes(&channel_id, 5, 1000);
    let bytes2 = example_gasless_tipping::build_tip_state_bytes(&channel_id, 5, 1000);
    assert_eq!(bytes1, bytes2);

    let bytes3 = example_gasless_tipping::build_tip_state_bytes(&channel_id, 6, 1000);
    assert!(bytes1 != bytes3);

    let bytes4 = example_gasless_tipping::build_tip_state_bytes(&channel_id, 5, 2000);
    assert!(bytes1 != bytes4);
}

#[test]
fun tip_state_accessors() {
    let state = example_gasless_tipping::create_tip_state(b"chan", 3, 750);
    assert_eq!(*example_gasless_tipping::tip_state_channel_id(&state), b"chan");
    assert_eq!(example_gasless_tipping::tip_state_nonce(&state), 3);
    assert_eq!(example_gasless_tipping::tip_state_total_tipped(&state), 750);

    let signed = example_gasless_tipping::create_signed_tip(state, b"sig");
    assert_eq!(
        example_gasless_tipping::tip_state_nonce(
            example_gasless_tipping::signed_tip_state(&signed),
        ),
        3,
    );
    assert_eq!(*example_gasless_tipping::signed_tip_sig(&signed), b"sig");
}

#[test]
fun open_tip_channel() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);
    let deposit = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let channel = example_gasless_tipping::open_tip_channel<SUI>(
        @0x2,
        deposit,
        PK,
        &clock,
        &mut ctx,
    );

    assert_eq!(example_gasless_tipping::channel_tipper<SUI>(&channel), @0x0);
    assert_eq!(example_gasless_tipping::channel_creator<SUI>(&channel), @0x2);
    assert_eq!(example_gasless_tipping::channel_total_deposited<SUI>(&channel), 10000);
    assert_eq!(example_gasless_tipping::channel_total_tipped<SUI>(&channel), 0);
    assert_eq!(example_gasless_tipping::channel_nonce<SUI>(&channel), 0);
    assert_eq!(example_gasless_tipping::channel_status<SUI>(&channel), 0);
    assert_eq!(example_gasless_tipping::channel_balance<SUI>(&channel), 10000);
    assert_eq!(
        example_gasless_tipping::channel_refund_after<SUI>(&channel),
        1000 + REFUND_TIMEOUT_MS,
    );
    assert!(example_gasless_tipping::is_open<SUI>(&channel));
    assert!(!example_gasless_tipping::can_refund<SUI>(&channel, &clock));

    example_gasless_tipping::destroy_tip_channel_for_testing<SUI>(channel);
    clock.destroy_for_testing();
}

#[test]
fun settle_tips_pays_creator_and_refunds_tipper() {
    let tipper = @0xA;
    let creator = @0xB;
    let mut scenario = sui::test_scenario::begin(tipper);

    let clock = clock::create_for_testing(scenario.ctx());
    let deposit = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut channel = example_gasless_tipping::open_tip_channel<SUI>(
        creator,
        deposit,
        PK,
        &clock,
        scenario.ctx(),
    );

    // Happy settlement uses the no-sig helper because the signed message binds the
    // dynamically-generated on-chain channel id, so a valid signature cannot be
    // precomputed in a unit test; the real signature gate is covered separately.
    scenario.next_tx(@0xC);
    example_gasless_tipping::settle_tips_no_sig_for_testing<SUI>(
        &mut channel,
        3000,
        1,
        scenario.ctx(),
    );

    assert_eq!(example_gasless_tipping::channel_status<SUI>(&channel), 1);
    assert_eq!(example_gasless_tipping::channel_total_tipped<SUI>(&channel), 3000);
    assert_eq!(example_gasless_tipping::channel_nonce<SUI>(&channel), 1);
    assert_eq!(example_gasless_tipping::channel_balance<SUI>(&channel), 0);

    scenario.next_tx(tipper);
    let creator_coin = scenario.take_from_address<coin::Coin<SUI>>(creator);
    assert_eq!(creator_coin.value(), 3000);
    let tipper_coin = scenario.take_from_address<coin::Coin<SUI>>(tipper);
    assert_eq!(tipper_coin.value(), 7000);

    destroy(creator_coin);
    destroy(tipper_coin);
    example_gasless_tipping::destroy_tip_channel_for_testing<SUI>(channel);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun settle_tips_full_pot_to_creator() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(5000, &mut ctx);

    let mut channel = example_gasless_tipping::open_tip_channel<SUI>(
        @0x2,
        deposit,
        PK,
        &clock,
        &mut ctx,
    );

    example_gasless_tipping::settle_tips_no_sig_for_testing<SUI>(&mut channel, 5000, 1, &mut ctx);

    assert_eq!(example_gasless_tipping::channel_total_tipped<SUI>(&channel), 5000);
    assert_eq!(example_gasless_tipping::channel_balance<SUI>(&channel), 0);

    example_gasless_tipping::destroy_tip_channel_for_testing<SUI>(channel);
    clock.destroy_for_testing();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_gasless_tipping::EInvalidSignature,
        location = sui_tunnel::example_gasless_tipping,
    ),
]
fun settle_tips_real_rejects_bad_signature() {
    let tipper = @0xA;
    let mut scenario = sui::test_scenario::begin(tipper);

    let clock = clock::create_for_testing(scenario.ctx());
    let deposit = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut channel = example_gasless_tipping::open_tip_channel<SUI>(
        @0x2,
        deposit,
        PK,
        &clock,
        scenario.ctx(),
    );

    // A relayer (not the tipper) submits, so the caller gate passes and execution
    // reaches the live ed25519 check in the real settle_tips. The signature is the
    // correct 64-byte length but cryptographically invalid, so verification returns
    // false and the example's own gate aborts (a wrong-length sig would instead trip
    // the length guard inside sui_tunnel::signature).
    scenario.next_tx(@0xC);
    let bad_sig =
        x"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    example_gasless_tipping::settle_tips<SUI>(
        &mut channel,
        3000,
        1,
        bad_sig,
        scenario.ctx(),
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_gasless_tipping::ENotAuthorized,
        location = sui_tunnel::example_gasless_tipping,
    ),
]
fun settle_tips_rejects_tipper_as_settler() {
    let tipper = @0xA;
    let mut scenario = sui::test_scenario::begin(tipper);

    let clock = clock::create_for_testing(scenario.ctx());
    let deposit = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut channel = example_gasless_tipping::open_tip_channel<SUI>(
        @0x2,
        deposit,
        PK,
        &clock,
        scenario.ctx(),
    );

    // The tipper cannot settle: they could pick an old, low total to underpay the
    // creator and keep a larger refund. The caller gate aborts before the signature
    // check, so the placeholder signature is never reached.
    let any_sig =
        x"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    example_gasless_tipping::settle_tips<SUI>(
        &mut channel,
        1000,
        1,
        any_sig,
        scenario.ctx(),
    );

    abort
}

#[test]
fun refund_tipper_returns_full_pot() {
    let tipper = @0xA;
    let mut scenario = sui::test_scenario::begin(tipper);

    let mut clock = clock::create_for_testing(scenario.ctx());
    let deposit = coin::mint_for_testing<SUI>(8000, scenario.ctx());

    let mut channel = example_gasless_tipping::open_tip_channel<SUI>(
        @0xB,
        deposit,
        PK,
        &clock,
        scenario.ctx(),
    );

    clock.set_for_testing(REFUND_TIMEOUT_MS + 1);
    assert!(example_gasless_tipping::can_refund<SUI>(&channel, &clock));

    example_gasless_tipping::refund_tipper<SUI>(&mut channel, &clock, scenario.ctx());

    assert_eq!(example_gasless_tipping::channel_status<SUI>(&channel), 2);
    assert_eq!(example_gasless_tipping::channel_balance<SUI>(&channel), 0);

    scenario.next_tx(tipper);
    let refund = scenario.take_from_address<coin::Coin<SUI>>(tipper);
    assert_eq!(refund.value(), 8000);

    destroy(refund);
    example_gasless_tipping::destroy_tip_channel_for_testing<SUI>(channel);
    clock.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_gasless_tipping::EInvalidParties,
        location = sui_tunnel::example_gasless_tipping,
    ),
]
fun open_tip_channel_same_party() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let channel = example_gasless_tipping::open_tip_channel<SUI>(
        @0x0, // same as the dummy sender
        deposit,
        PK,
        &clock,
        &mut ctx,
    );

    example_gasless_tipping::destroy_tip_channel_for_testing<SUI>(channel);
    clock.destroy_for_testing();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_gasless_tipping::EInvalidDepositAmount,
        location = sui_tunnel::example_gasless_tipping,
    ),
]
fun open_tip_channel_zero_deposit() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(0, &mut ctx);

    let channel = example_gasless_tipping::open_tip_channel<SUI>(
        @0x2,
        deposit,
        PK,
        &clock,
        &mut ctx,
    );

    example_gasless_tipping::destroy_tip_channel_for_testing<SUI>(channel);
    clock.destroy_for_testing();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_gasless_tipping::EInvalidPublicKey,
        location = sui_tunnel::example_gasless_tipping,
    ),
]
fun open_tip_channel_empty_pk() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let channel = example_gasless_tipping::open_tip_channel<SUI>(
        @0x2,
        deposit,
        vector[],
        &clock,
        &mut ctx,
    );

    example_gasless_tipping::destroy_tip_channel_for_testing<SUI>(channel);
    clock.destroy_for_testing();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_gasless_tipping::EInvalidNonce,
        location = sui_tunnel::example_gasless_tipping,
    ),
]
fun settle_tips_stale_nonce() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut channel = example_gasless_tipping::open_tip_channel<SUI>(
        @0x2,
        deposit,
        PK,
        &clock,
        &mut ctx,
    );

    // nonce 0 is not strictly greater than the channel's nonce 0
    example_gasless_tipping::settle_tips_no_sig_for_testing<SUI>(&mut channel, 1000, 0, &mut ctx);

    example_gasless_tipping::destroy_tip_channel_for_testing<SUI>(channel);
    clock.destroy_for_testing();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_gasless_tipping::EInsufficientBalance,
        location = sui_tunnel::example_gasless_tipping,
    ),
]
fun settle_tips_exceeds_deposit() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut channel = example_gasless_tipping::open_tip_channel<SUI>(
        @0x2,
        deposit,
        PK,
        &clock,
        &mut ctx,
    );

    // 20000 tipped exceeds the 10000 deposit
    example_gasless_tipping::settle_tips_no_sig_for_testing<SUI>(&mut channel, 20000, 1, &mut ctx);

    example_gasless_tipping::destroy_tip_channel_for_testing<SUI>(channel);
    clock.destroy_for_testing();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_gasless_tipping::ERegressingTotal,
        location = sui_tunnel::example_gasless_tipping,
    ),
]
fun settle_tips_below_previous_total() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut channel = example_gasless_tipping::open_tip_channel<SUI>(
        @0x2,
        deposit,
        PK,
        &clock,
        &mut ctx,
    );

    // Commit a total of 4000 via a forced status reset so the channel stays open.
    example_gasless_tipping::settle_tips_no_sig_for_testing<SUI>(&mut channel, 4000, 1, &mut ctx);
    example_gasless_tipping::set_status_for_testing<SUI>(
        &mut channel,
        example_gasless_tipping::tip_open(),
    );

    // 3000 regresses below the committed 4000
    example_gasless_tipping::settle_tips_no_sig_for_testing<SUI>(&mut channel, 3000, 2, &mut ctx);

    example_gasless_tipping::destroy_tip_channel_for_testing<SUI>(channel);
    clock.destroy_for_testing();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_gasless_tipping::ENotAuthorized,
        location = sui_tunnel::example_gasless_tipping,
    ),
]
fun refund_tipper_non_tipper() {
    let tipper = @0xA;
    let mut scenario = sui::test_scenario::begin(tipper);

    let mut clock = clock::create_for_testing(scenario.ctx());
    let deposit = coin::mint_for_testing<SUI>(8000, scenario.ctx());

    let mut channel = example_gasless_tipping::open_tip_channel<SUI>(
        @0xB,
        deposit,
        PK,
        &clock,
        scenario.ctx(),
    );

    clock.set_for_testing(REFUND_TIMEOUT_MS + 1);

    // A non-tipper attempts the refund.
    scenario.next_tx(@0xC);
    example_gasless_tipping::refund_tipper<SUI>(&mut channel, &clock, scenario.ctx());

    example_gasless_tipping::destroy_tip_channel_for_testing<SUI>(channel);
    clock.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_gasless_tipping::ETimeoutNotReached,
        location = sui_tunnel::example_gasless_tipping,
    ),
]
fun refund_tipper_before_window() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(8000, &mut ctx);

    let mut channel = example_gasless_tipping::open_tip_channel<SUI>(
        @0x2,
        deposit,
        PK,
        &clock,
        &mut ctx,
    );

    // Refund before the timeout window has elapsed.
    example_gasless_tipping::refund_tipper<SUI>(&mut channel, &clock, &mut ctx);

    example_gasless_tipping::destroy_tip_channel_for_testing<SUI>(channel);
    clock.destroy_for_testing();
}
