#[test_only]
module sui_tunnel::example_payment_channel_tests;

use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui_tunnel::example_payment_channel;

const PARTY_A: address = @0xA;
const PARTY_B: address = @0xB;

#[test]
fun create_state_bytes() {
    let channel_id = b"test_channel";
    let nonce = 5u64;
    let balance_a = 1000u64;
    let balance_b = 500u64;

    let bytes1 = example_payment_channel::create_state_bytes(
        &channel_id,
        nonce,
        balance_a,
        balance_b,
    );
    let bytes2 = example_payment_channel::create_state_bytes(
        &channel_id,
        nonce,
        balance_a,
        balance_b,
    );

    // Same inputs should produce same bytes
    assert_eq!(bytes1, bytes2);

    // Different inputs should produce different bytes
    let bytes3 = example_payment_channel::create_state_bytes(
        &channel_id,
        nonce + 1,
        balance_a,
        balance_b,
    );
    assert!(bytes1 != bytes3);
}

#[test]
fun create_payment_state() {
    let state = example_payment_channel::create_payment_state(
        b"channel_123",
        10,
        5000,
        3000,
    );

    assert_eq!(*example_payment_channel::state_channel_id(&state), b"channel_123");
    assert_eq!(example_payment_channel::state_nonce(&state), 10);
    assert_eq!(example_payment_channel::state_balance_a(&state), 5000);
    assert_eq!(example_payment_channel::state_balance_b(&state), 3000);
}

#[test]
fun create_signed_state() {
    let state = example_payment_channel::create_payment_state(b"channel", 1, 100, 200);
    let signed = example_payment_channel::create_signed_state(state, b"sig_a", b"sig_b");

    assert_eq!(
        example_payment_channel::state_nonce(example_payment_channel::signed_state(&signed)),
        1,
    );
    assert_eq!(*example_payment_channel::signed_sig_a(&signed), b"sig_a");
    assert_eq!(*example_payment_channel::signed_sig_b(&signed), b"sig_b");
}

#[test]
fun status_constants() {
    assert_eq!(example_payment_channel::channel_open(), 0);
    assert_eq!(example_payment_channel::channel_closing(), 1);
    assert_eq!(example_payment_channel::channel_closed(), 2);
    assert_eq!(example_payment_channel::dispute_period_ms(), 3600000);
}

// A pays B a net amount: A funded the whole pot yet B's agreed final balance is
// drawn from the merged pool, which the old per-pool split would have trapped.
#[test]
fun cooperative_close_pays_cross_party_split() {
    let mut scenario = sui::test_scenario::begin(PARTY_A);

    let deposit_a = coin::mint_for_testing<SUI>(10000, scenario.ctx());
    let deposit_b = coin::mint_for_testing<SUI>(0, scenario.ctx());
    let mut channel = example_payment_channel::create_funded_for_testing<SUI>(
        PARTY_A,
        PARTY_B,
        deposit_a,
        deposit_b,
        scenario.ctx(),
    );

    example_payment_channel::cooperative_close_no_sig_for_testing<SUI>(
        &mut channel,
        1,
        3000,
        7000,
        scenario.ctx(),
    );

    assert_eq!(example_payment_channel::channel_status<SUI>(&channel), 2);
    assert_eq!(example_payment_channel::channel_nonce<SUI>(&channel), 1);
    assert_eq!(example_payment_channel::channel_total_balance<SUI>(&channel), 0);

    scenario.next_tx(PARTY_A);
    let coin_a = scenario.take_from_address<coin::Coin<SUI>>(PARTY_A);
    assert_eq!(coin_a.value(), 3000);
    let coin_b = scenario.take_from_address<coin::Coin<SUI>>(PARTY_B);
    assert_eq!(coin_b.value(), 7000);

    destroy(coin_a);
    destroy(coin_b);
    example_payment_channel::destroy_for_testing<SUI>(channel);
    scenario.end();
}

// B funded the whole pot but the agreed split pays A out of the merged pool.
#[test]
fun finalize_close_pays_cross_party_split() {
    let mut scenario = sui::test_scenario::begin(PARTY_A);
    let mut clk = clock::create_for_testing(scenario.ctx());

    let deposit_a = coin::mint_for_testing<SUI>(0, scenario.ctx());
    let deposit_b = coin::mint_for_testing<SUI>(8000, scenario.ctx());
    let mut channel = example_payment_channel::create_funded_for_testing<SUI>(
        PARTY_A,
        PARTY_B,
        deposit_a,
        deposit_b,
        scenario.ctx(),
    );

    example_payment_channel::set_closing_for_testing<SUI>(&mut channel, 3, 5000, 3000, 0);
    clk.set_for_testing(example_payment_channel::dispute_period_ms());

    example_payment_channel::finalize_close<SUI>(&mut channel, &clk, scenario.ctx());

    assert_eq!(example_payment_channel::channel_status<SUI>(&channel), 2);
    assert_eq!(example_payment_channel::channel_total_balance<SUI>(&channel), 0);

    scenario.next_tx(PARTY_A);
    let coin_a = scenario.take_from_address<coin::Coin<SUI>>(PARTY_A);
    assert_eq!(coin_a.value(), 5000);
    let coin_b = scenario.take_from_address<coin::Coin<SUI>>(PARTY_B);
    assert_eq!(coin_b.value(), 3000);

    destroy(coin_a);
    destroy(coin_b);
    clk.destroy_for_testing();
    example_payment_channel::destroy_for_testing<SUI>(channel);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_payment_channel::EInvalidSignature,
        location = sui_tunnel::example_payment_channel,
    ),
]
fun cooperative_close_real_rejects_bad_signature() {
    let mut scenario = sui::test_scenario::begin(PARTY_A);

    let deposit_a = coin::mint_for_testing<SUI>(6000, scenario.ctx());
    let deposit_b = coin::mint_for_testing<SUI>(4000, scenario.ctx());
    let mut channel = example_payment_channel::create_funded_for_testing<SUI>(
        PARTY_A,
        PARTY_B,
        deposit_a,
        deposit_b,
        scenario.ctx(),
    );

    // Balances sum to the pot and the nonce advances, so every guard passes and
    // execution reaches the live ed25519 check in the real cooperative_close. The
    // signature is the correct 64-byte length but cryptographically invalid, so
    // verification returns false and the example's own gate aborts (a wrong-length
    // sig would instead trip the length guard inside sui_tunnel::signature).
    let bad_sig =
        x"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    example_payment_channel::cooperative_close<SUI>(
        &mut channel,
        1,
        3000,
        7000,
        bad_sig,
        bad_sig,
        scenario.ctx(),
    );

    example_payment_channel::destroy_for_testing<SUI>(channel);
    scenario.end();
}

#[test]
#[
    expected_failure(
        abort_code = sui_tunnel::example_payment_channel::EInvalidNonce,
        location = sui_tunnel::example_payment_channel,
    ),
]
fun cooperative_close_rejects_replayed_nonce() {
    let mut scenario = sui::test_scenario::begin(PARTY_A);

    let deposit_a = coin::mint_for_testing<SUI>(6000, scenario.ctx());
    let deposit_b = coin::mint_for_testing<SUI>(4000, scenario.ctx());
    let mut channel = example_payment_channel::create_funded_for_testing<SUI>(
        PARTY_A,
        PARTY_B,
        deposit_a,
        deposit_b,
        scenario.ctx(),
    );

    // Advance the channel nonce past a stale signed split.
    example_payment_channel::set_closing_for_testing<SUI>(&mut channel, 5, 6000, 4000, 0);
    example_payment_channel::set_status_open_for_testing<SUI>(&mut channel);

    // Replaying nonce 5 (not strictly greater) must abort.
    example_payment_channel::cooperative_close_no_sig_for_testing<SUI>(
        &mut channel,
        5,
        9000,
        1000,
        scenario.ctx(),
    );

    example_payment_channel::destroy_for_testing<SUI>(channel);
    scenario.end();
}
