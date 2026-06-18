#[test_only]
module sui_tunnel::example_payment_channel_tests;

use std::unit_test::assert_eq;
use sui_tunnel::example_payment_channel;

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

    assert_eq!(*state.state_channel_id(), b"channel_123");
    assert_eq!(state.state_nonce(), 10);
    assert_eq!(state.state_balance_a(), 5000);
    assert_eq!(state.state_balance_b(), 3000);
}

#[test]
fun create_signed_state() {
    let state = example_payment_channel::create_payment_state(b"channel", 1, 100, 200);
    let signed = state.create_signed_state(b"sig_a", b"sig_b");

    assert_eq!(signed.signed_state().state_nonce(), 1);
    assert_eq!(*signed.signed_sig_a(), b"sig_a");
    assert_eq!(*signed.signed_sig_b(), b"sig_b");
}

#[test]
fun status_constants() {
    assert_eq!(example_payment_channel::channel_open(), 0);
    assert_eq!(example_payment_channel::channel_closing(), 1);
    assert_eq!(example_payment_channel::channel_closed(), 2);
    assert_eq!(example_payment_channel::dispute_period_ms(), 3600000);
}
