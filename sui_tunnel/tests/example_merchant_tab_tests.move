#[test_only]
module sui_tunnel::example_merchant_tab_tests;

use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui_tunnel::example_merchant_tab;

const MERCHANT: address = @0xB0B;
const CUSTOMER_PK: vector<u8> = b"customer_public_key_for_tests___";
const MERCHANT_PK: vector<u8> = b"merchant_public_key_for_tests___";

#[test]
fun status_constants() {
    assert_eq!(example_merchant_tab::tab_open(), 0);
    assert_eq!(example_merchant_tab::tab_settling(), 1);
    assert_eq!(example_merchant_tab::tab_settled(), 2);
    assert_eq!(example_merchant_tab::settle_dispute_ms(), 600000);
}

#[test]
fun build_tap_state_bytes() {
    let tab_id = b"test_tab";
    let nonce = 5u64;
    let customer_balance = 1000u64;
    let merchant_balance = 500u64;

    let bytes1 = example_merchant_tab::build_tap_state_bytes(
        &tab_id,
        nonce,
        customer_balance,
        merchant_balance,
    );
    let bytes2 = example_merchant_tab::build_tap_state_bytes(
        &tab_id,
        nonce,
        customer_balance,
        merchant_balance,
    );

    // Same inputs should produce same bytes
    assert_eq!(bytes1, bytes2);

    // Different nonce should produce different bytes
    let bytes3 = example_merchant_tab::build_tap_state_bytes(
        &tab_id,
        nonce + 1,
        customer_balance,
        merchant_balance,
    );
    assert!(bytes1 != bytes3);
}

#[test]
fun tap_state_hash_length() {
    let tab_id = b"test_tab";
    let bytes = example_merchant_tab::build_tap_state_bytes(&tab_id, 1, 100, 200);
    let h = sui::hash::blake2b256(&bytes);
    assert_eq!(h.length(), 32);
}

#[test]
fun create_tab_state() {
    let state = example_merchant_tab::create_tab_state(
        b"tab_123",
        10,
        5000,
        3000,
    );

    assert_eq!(*example_merchant_tab::state_tab_id(&state), b"tab_123");
    assert_eq!(example_merchant_tab::state_nonce(&state), 10);
    assert_eq!(example_merchant_tab::state_customer_balance(&state), 5000);
    assert_eq!(example_merchant_tab::state_merchant_balance(&state), 3000);
}

#[test]
fun create_signed_tab_state() {
    let state = example_merchant_tab::create_tab_state(b"tab", 1, 100, 200);
    let signed = example_merchant_tab::create_signed_tab_state(state, b"sig_a", b"sig_b");

    assert_eq!(example_merchant_tab::state_nonce(example_merchant_tab::signed_state(&signed)), 1);
    assert_eq!(*example_merchant_tab::signed_sig_a(&signed), b"sig_a");
    assert_eq!(*example_merchant_tab::signed_sig_b(&signed), b"sig_b");
}

#[test]
fun open_and_join_happy_path() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    assert_eq!(example_merchant_tab::tab_status(&tab), example_merchant_tab::tab_open());
    assert_eq!(example_merchant_tab::tab_customer_balance(&tab), 1000);
    assert_eq!(example_merchant_tab::tab_merchant_balance(&tab), 0);
    assert_eq!(example_merchant_tab::tab_merchant(&tab), MERCHANT);

    // Merchant joins from their address with a zero deposit
    let mut merchant_ctx = sui::test_scenario::begin(MERCHANT);
    let zero = coin::zero<SUI>(merchant_ctx.ctx());
    example_merchant_tab::merchant_join(&mut tab, zero, MERCHANT_PK, merchant_ctx.ctx());

    assert_eq!(example_merchant_tab::tab_merchant_balance(&tab), 0);
    assert_eq!(example_merchant_tab::tab_total_balance(&tab), 1000);
    assert_eq!(*example_merchant_tab::tab_merchant_pk(&tab), MERCHANT_PK);

    merchant_ctx.end();
    example_merchant_tab::destroy_merchant_tab_for_testing(tab);
    clock.destroy_for_testing();
}

#[test]
fun top_up_increases_customer_balance() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    let more = coin::mint_for_testing<SUI>(500, &mut ctx);
    example_merchant_tab::top_up_tab(&mut tab, more, &ctx);

    assert_eq!(example_merchant_tab::tab_customer_balance(&tab), 1500);
    example_merchant_tab::destroy_merchant_tab_for_testing(tab);
    clock.destroy_for_testing();
}

#[test]
fun finalize_settle_pays_parties() {
    let mut scenario = sui::test_scenario::begin(@0xA11CE);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut tab = example_merchant_tab::open_tab(
        MERCHANT,
        deposit,
        CUSTOMER_PK,
        &clock,
        scenario.ctx(),
    );

    // Drain 700 toward the merchant via the no-sig settle helper
    example_merchant_tab::initiate_settle_no_sig_for_testing(
        &mut tab,
        1,
        300,
        700,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(example_merchant_tab::tab_status(&tab), example_merchant_tab::tab_settling());

    // Advance past the dispute window
    clock.set_for_testing(1000 + example_merchant_tab::settle_dispute_ms());
    example_merchant_tab::finalize_settle(&mut tab, &clock, scenario.ctx());
    assert_eq!(example_merchant_tab::tab_status(&tab), example_merchant_tab::tab_settled());

    scenario.next_tx(@0xA11CE);
    let customer_coin = scenario.take_from_address<coin::Coin<SUI>>(@0xA11CE);
    assert_eq!(customer_coin.value(), 300);
    let merchant_coin = scenario.take_from_address<coin::Coin<SUI>>(MERCHANT);
    assert_eq!(merchant_coin.value(), 700);

    destroy(customer_coin);
    destroy(merchant_coin);
    example_merchant_tab::destroy_merchant_tab_for_testing(tab);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun challenge_settle_advances_state_and_finalizes() {
    let customer = @0xA11CE;
    let mut scenario = sui::test_scenario::begin(customer);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut tab = example_merchant_tab::open_tab(
        MERCHANT,
        deposit,
        CUSTOMER_PK,
        &clock,
        scenario.ctx(),
    );

    // Initial checkpoint proposes 300 to the customer at nonce 1.
    example_merchant_tab::initiate_settle_no_sig_for_testing(
        &mut tab,
        1,
        300,
        700,
        &clock,
        scenario.ctx(),
    );

    // A higher-nonce tap overrides it within the window, draining further toward the
    // merchant; the nonce advances and the balance snapshot is replaced.
    example_merchant_tab::challenge_settle_no_sig_for_testing(
        &mut tab,
        2,
        100,
        900,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(example_merchant_tab::tab_nonce(&tab), 2);
    assert_eq!(example_merchant_tab::tab_status(&tab), example_merchant_tab::tab_settling());

    // Finalizing after the restarted window pays the challenged split, proving the
    // snapshot advanced to nonce 2 rather than paying the original 300/700.
    clock.set_for_testing(1000 + example_merchant_tab::settle_dispute_ms());
    example_merchant_tab::finalize_settle(&mut tab, &clock, scenario.ctx());

    scenario.next_tx(customer);
    let customer_coin = scenario.take_from_address<coin::Coin<SUI>>(customer);
    assert_eq!(customer_coin.value(), 100);
    let merchant_coin = scenario.take_from_address<coin::Coin<SUI>>(MERCHANT);
    assert_eq!(merchant_coin.value(), 900);

    destroy(customer_coin);
    destroy(merchant_coin);
    example_merchant_tab::destroy_merchant_tab_for_testing(tab);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun checkout_pays_parties() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    example_merchant_tab::checkout_no_sig_for_testing(&mut tab, 1, 250, 750, &mut ctx);

    assert_eq!(example_merchant_tab::tab_status(&tab), example_merchant_tab::tab_settled());
    assert_eq!(example_merchant_tab::tab_nonce(&tab), 1);
    assert_eq!(example_merchant_tab::tab_total_balance(&tab), 0);
    example_merchant_tab::destroy_merchant_tab_for_testing(tab);
    clock.destroy_for_testing();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::EInvalidNonce,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun checkout_rejects_stale_nonce() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    // Advance the tab nonce so a later replay at the same nonce is stale
    example_merchant_tab::set_nonce_for_testing(&mut tab, 5);

    // Replaying an old checkout split at nonce <= tab.nonce must abort
    example_merchant_tab::checkout_no_sig_for_testing(&mut tab, 5, 250, 750, &mut ctx);

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::EInvalidStateTransition,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun monotonic_drain_rejects_customer_increase() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    // Drain to a customer balance of 300 (proposed checkpoint)
    example_merchant_tab::initiate_settle_no_sig_for_testing(&mut tab, 1, 300, 700, &clock, &ctx);

    // A higher-nonce challenge that still conserves funds (400 + 600 == 1000) but
    // raises the customer's balance above the 300 checkpoint must be rejected.
    // The drain check fires before signature verification, so dummy sigs are fine.
    example_merchant_tab::challenge_settle(&mut tab, 2, 400, 600, b"sig_a", b"sig_b", &clock, &ctx);

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::EInvalidSignature,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun initiate_settle_real_rejects_bad_signature() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    // Balances sum to the pot and nonce 1 advances past 0, so every guard passes and
    // execution reaches the live ed25519 check in the real initiate_settle. The
    // signature is the correct 64-byte length but cryptographically invalid, so
    // verification returns false and the example's own gate aborts.
    let bad_sig =
        x"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    example_merchant_tab::initiate_settle(
        &mut tab,
        1,
        300,
        700,
        bad_sig,
        bad_sig,
        &clock,
        &ctx,
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::EInvalidSignature,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun checkout_real_rejects_bad_signature() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    // Balances sum to the pot and nonce 1 advances past 0, so every guard passes
    // and execution reaches the live ed25519 check in the real checkout. The
    // signature is the correct 64-byte length but cryptographically invalid, so
    // verification returns false and the example's own gate aborts.
    let bad_sig =
        x"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    example_merchant_tab::checkout(
        &mut tab,
        1,
        250,
        750,
        bad_sig,
        bad_sig,
        &mut ctx,
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::ENotAuthorized,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun top_up_rejects_non_customer() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    let mut merchant_ctx = sui::test_scenario::begin(MERCHANT);
    let more = coin::mint_for_testing<SUI>(500, merchant_ctx.ctx());
    example_merchant_tab::top_up_tab(&mut tab, more, merchant_ctx.ctx());

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::EInvalidState,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun finalize_rejects_wrong_status() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    // Still TAB_OPEN, finalize requires TAB_SETTLING
    example_merchant_tab::finalize_settle(&mut tab, &clock, &mut ctx);

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::EInvalidNonce,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun challenge_rejects_stale_nonce() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    example_merchant_tab::set_status_for_testing(&mut tab, example_merchant_tab::tab_settling());

    // Challenge with a nonce that is not strictly higher than the current 0
    example_merchant_tab::challenge_settle(
        &mut tab,
        0,
        300,
        700,
        b"sig_a",
        b"sig_b",
        &clock,
        &ctx,
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::EInvalidParties,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun open_tab_same_party() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    // dummy sender @0x0 is the customer; making the merchant @0x0 too is rejected
    let _tab = example_merchant_tab::open_tab(@0x0, deposit, CUSTOMER_PK, &clock, &mut ctx);

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::EInvalidPublicKey,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun open_tab_empty_pk() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let _tab = example_merchant_tab::open_tab(MERCHANT, deposit, b"", &clock, &mut ctx);

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::EAlreadyExists,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun merchant_join_twice() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    let mut merchant_ctx = sui::test_scenario::begin(MERCHANT);
    let first = coin::zero<SUI>(merchant_ctx.ctx());
    example_merchant_tab::merchant_join(&mut tab, first, MERCHANT_PK, merchant_ctx.ctx());
    let second = coin::zero<SUI>(merchant_ctx.ctx());
    example_merchant_tab::merchant_join(&mut tab, second, MERCHANT_PK, merchant_ctx.ctx());

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::EInvalidPublicKey,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun merchant_join_empty_pk() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    let mut merchant_ctx = sui::test_scenario::begin(MERCHANT);
    let zero = coin::zero<SUI>(merchant_ctx.ctx());
    example_merchant_tab::merchant_join(&mut tab, zero, b"", merchant_ctx.ctx());

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::ETunnelClosed,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun top_up_after_settling_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    example_merchant_tab::set_status_for_testing(&mut tab, example_merchant_tab::tab_settling());
    let more = coin::mint_for_testing<SUI>(500, &mut ctx);
    example_merchant_tab::top_up_tab(&mut tab, more, &ctx);

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::ETimeoutNotReached,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun finalize_before_window_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    example_merchant_tab::initiate_settle_no_sig_for_testing(&mut tab, 1, 300, 700, &clock, &ctx);
    // Dispute window has not elapsed
    example_merchant_tab::finalize_settle(&mut tab, &clock, &mut ctx);

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::EDisputePeriodEnded,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun challenge_after_window_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    example_merchant_tab::initiate_settle_no_sig_for_testing(&mut tab, 1, 300, 700, &clock, &ctx);
    clock.set_for_testing(1000 + example_merchant_tab::settle_dispute_ms() + 1);
    example_merchant_tab::challenge_settle(&mut tab, 2, 200, 800, b"sig_a", b"sig_b", &clock, &ctx);

    abort
}

#[test]
fun refund_returns_prepayment_after_timeout() {
    let customer = @0xA11CE;
    let mut scenario = sui::test_scenario::begin(customer);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut tab = example_merchant_tab::open_tab(
        MERCHANT,
        deposit,
        CUSTOMER_PK,
        &clock,
        scenario.ctx(),
    );

    // Merchant never joins; after the refund window the customer reclaims the pot
    clock.set_for_testing(1000 + example_merchant_tab::refund_timeout_ms());
    example_merchant_tab::refund_tab(&mut tab, &clock, scenario.ctx());

    assert_eq!(example_merchant_tab::tab_status(&tab), example_merchant_tab::tab_refunded());
    assert_eq!(example_merchant_tab::tab_total_balance(&tab), 0);

    scenario.next_tx(customer);
    let refunded = scenario.take_from_address<coin::Coin<SUI>>(customer);
    assert_eq!(refunded.value(), 1000);

    destroy(refunded);
    example_merchant_tab::destroy_merchant_tab_for_testing(tab);
    clock.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::ETimeoutNotReached,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun refund_before_timeout_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    // Refund window has not elapsed
    example_merchant_tab::refund_tab(&mut tab, &clock, &mut ctx);

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::ENotAuthorized,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun refund_rejects_non_customer() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);
    clock.set_for_testing(1000 + example_merchant_tab::refund_timeout_ms());

    let mut merchant_ctx = sui::test_scenario::begin(MERCHANT);
    example_merchant_tab::refund_tab(&mut tab, &clock, merchant_ctx.ctx());

    abort
}

#[test]
fun finalize_pays_customer_more_than_own_pool() {
    let customer = @0xA11CE;
    let mut scenario = sui::test_scenario::begin(customer);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut tab = example_merchant_tab::open_tab(
        MERCHANT,
        deposit,
        CUSTOMER_PK,
        &clock,
        scenario.ctx(),
    );

    // Merchant posts 500 of collateral, so the customer pool holds 1000 of 1500
    scenario.next_tx(MERCHANT);
    let collateral = coin::mint_for_testing<SUI>(500, scenario.ctx());
    example_merchant_tab::merchant_join(&mut tab, collateral, MERCHANT_PK, scenario.ctx());

    // A co-signed split returns 1200 to the customer, more than its own 1000 pool.
    // Without merging both pools this would abort and trap all funds.
    example_merchant_tab::initiate_settle_no_sig_for_testing(
        &mut tab,
        1,
        1200,
        300,
        &clock,
        scenario.ctx(),
    );
    clock.set_for_testing(1000 + example_merchant_tab::settle_dispute_ms());
    example_merchant_tab::finalize_settle(&mut tab, &clock, scenario.ctx());

    scenario.next_tx(customer);
    let customer_coin = scenario.take_from_address<coin::Coin<SUI>>(customer);
    assert_eq!(customer_coin.value(), 1200);
    let merchant_coin = scenario.take_from_address<coin::Coin<SUI>>(MERCHANT);
    assert_eq!(merchant_coin.value(), 300);

    destroy(customer_coin);
    destroy(merchant_coin);
    example_merchant_tab::destroy_merchant_tab_for_testing(tab);
    clock.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_merchant_tab::EInvalidNonce,
        location = sui_tunnel::example_merchant_tab,
    ),
]
fun initiate_settle_rejects_equal_nonce() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);
    let deposit = coin::mint_for_testing<SUI>(1000, &mut ctx);
    let mut tab = example_merchant_tab::open_tab(MERCHANT, deposit, CUSTOMER_PK, &clock, &mut ctx);

    // Advance the checkpoint nonce, then a settle at the same nonce must be rejected
    // before signature verification, matching the strict check used elsewhere.
    example_merchant_tab::set_nonce_for_testing(&mut tab, 5);
    example_merchant_tab::initiate_settle(
        &mut tab,
        5,
        300,
        700,
        b"sig_a",
        b"sig_b",
        &clock,
        &ctx,
    );

    abort
}
