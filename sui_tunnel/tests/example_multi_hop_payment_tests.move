#[test_only]
module sui_tunnel::example_multi_hop_payment_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui_tunnel::example_multi_hop_payment;

#[test]
fun status_constants() {
    assert_eq!(example_multi_hop_payment::payment_created(), 0);
    assert_eq!(example_multi_hop_payment::payment_in_flight(), 1);
    assert_eq!(example_multi_hop_payment::payment_completed(), 2);
    assert_eq!(example_multi_hop_payment::payment_failed(), 3);
}

#[test]
fun create_invoice() {
    let preimage = b"secret_payment_preimage";
    let invoice = example_multi_hop_payment::create_invoice(
        &preimage,
        10000,
        @0xBEEF,
        3600000,
        b"Payment for goods",
    );

    assert_eq!(invoice.invoice_amount(), 10000);
    assert_eq!(invoice.invoice_receiver(), @0xBEEF);
    assert_eq!(invoice.invoice_expiry_ms(), 3600000);
    assert_eq!(*invoice.invoice_memo(), b"Payment for goods");

    // Payment hash should be 32 bytes
    assert_eq!(invoice.invoice_payment_hash().length(), 32);
}

#[test]
fun create_payment() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let preimage = b"test_preimage";
    let invoice = example_multi_hop_payment::create_invoice(
        &preimage,
        5000,
        @0xBEEF,
        3600000,
        b"Test",
    );

    let payment = invoice.create_payment(
        &clock,
        &mut ctx,
    );

    assert_eq!(payment.payment_amount(), 5000);
    assert_eq!(payment.payment_status(), 0);
    assert_eq!(payment.payment_total_fees(), 0);

    payment.destroy_for_testing();
    clock::destroy_for_testing(clock);
}

#[test]
fun add_payment_hops() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let preimage = b"test_preimage";
    let invoice = example_multi_hop_payment::create_invoice(
        &preimage,
        5000,
        @0xD,
        3600000,
        b"Test",
    );

    let mut payment = invoice.create_payment(
        &clock,
        &mut ctx,
    );

    // Add hops: A -> B -> C -> D
    payment.add_payment_hop(
        b"tunnel_ab",
        @0xB,
        100,
        3600000,
        &ctx,
    );
    payment.add_payment_hop(b"tunnel_bc", @0xC, 80, 3480000, &ctx);
    payment.add_payment_hop(b"tunnel_cd", @0xD, 60, 3360000, &ctx);

    assert_eq!(payment.payment_total_fees(), 240);
    assert_eq!(payment.payment_route().route_hop_count(), 3);

    payment.destroy_for_testing();
    clock::destroy_for_testing(clock);
}

#[test]
fun complete_payment_flow() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    // Simulate: Alice -> Bob -> Carol

    // Receiver creates invoice (receiver = @0x0 to match dummy ctx sender for claim)
    let preimage = b"carol_secret_preimage";
    let invoice = example_multi_hop_payment::create_invoice(
        &preimage,
        10000,
        @0x0,
        7200000,
        b"Pay receiver",
    );

    // Sender creates payment (sender = @0x0 from dummy ctx)
    let mut payment = invoice.create_payment(
        &clock,
        &mut ctx,
    );

    // Add route (last hop must be receiver @0x0)
    payment.add_payment_hop(
        b"sender_relay",
        @0xB,
        100,
        3600000,
        &ctx,
    );
    payment.add_payment_hop(
        b"relay_receiver",
        @0x0,
        50,
        3480000,
        &ctx,
    );

    // Validate route
    assert!(payment.validate_payment());

    // Setup HTLCs
    payment.setup_htlcs(3600000, &ctx);
    assert_eq!(payment.payment_status(), 1);
    assert_eq!(payment.payment_htlc_count(), 2);

    // Carol claims with preimage
    let claimed = payment.claim_payment(preimage, &ctx);
    assert!(claimed);
    assert_eq!(payment.payment_status(), 2);

    // Create receipt
    let receipt = payment.create_receipt(1234567900);
    assert_eq!(receipt.receipt_amount(), 10000);
    assert_eq!(receipt.receipt_fees(), 150);
    assert_eq!(*receipt.receipt_preimage(), preimage);

    payment.destroy_for_testing();
    clock::destroy_for_testing(clock);
}

#[test]
fun calculate_total_needed() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let preimage = b"test";
    let invoice = example_multi_hop_payment::create_invoice(&preimage, 10000, @0xB, 3600000, b"");

    let mut payment = invoice.create_payment(&clock, &mut ctx);
    payment.add_payment_hop(b"tunnel", @0xB, 500, 3600000, &ctx);

    assert_eq!(payment.calculate_total_needed(), 10500);

    payment.destroy_for_testing();
    clock::destroy_for_testing(clock);
}

#[test]
fun payment_with_wrong_preimage() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let preimage = b"correct_preimage";
    // Receiver = @0x0 to match dummy ctx sender for claim_payment auth
    let invoice = example_multi_hop_payment::create_invoice(&preimage, 1000, @0x0, 3600000, b"");

    let mut payment = invoice.create_payment(&clock, &mut ctx);
    payment.add_payment_hop(b"tunnel", @0x0, 100, 3600000, &ctx);

    payment.setup_htlcs(3600000, &ctx);

    // Try claiming with wrong preimage
    let claimed = payment.claim_payment(b"wrong_preimage", &ctx);
    assert!(!claimed);
    assert_eq!(payment.payment_status(), 1);

    payment.destroy_for_testing();
    clock::destroy_for_testing(clock);
}
