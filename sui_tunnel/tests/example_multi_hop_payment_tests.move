#[test_only]
module sui_tunnel::example_multi_hop_payment_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui_tunnel::example_multi_hop_payment;
use sui_tunnel::hop;

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

    assert_eq!(example_multi_hop_payment::invoice_amount(&invoice), 10000);
    assert_eq!(example_multi_hop_payment::invoice_receiver(&invoice), @0xBEEF);
    assert_eq!(example_multi_hop_payment::invoice_expiry_ms(&invoice), 3600000);
    assert_eq!(*example_multi_hop_payment::invoice_memo(&invoice), b"Payment for goods");

    // Payment hash should be 32 bytes
    assert_eq!(example_multi_hop_payment::invoice_payment_hash(&invoice).length(), 32);
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

    let payment = example_multi_hop_payment::create_payment(
        &invoice,
        &clock,
        &mut ctx,
    );

    assert_eq!(example_multi_hop_payment::payment_amount(&payment), 5000);
    assert_eq!(example_multi_hop_payment::payment_status(&payment), 0);
    assert_eq!(example_multi_hop_payment::payment_total_fees(&payment), 0);

    example_multi_hop_payment::destroy_for_testing(payment);
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

    let mut payment = example_multi_hop_payment::create_payment(
        &invoice,
        &clock,
        &mut ctx,
    );

    // Add hops: A -> B -> C -> D
    example_multi_hop_payment::add_payment_hop(
        &mut payment,
        b"tunnel_ab",
        @0xB,
        100,
        3600000,
        &ctx,
    );
    example_multi_hop_payment::add_payment_hop(&mut payment, b"tunnel_bc", @0xC, 80, 3480000, &ctx);
    example_multi_hop_payment::add_payment_hop(&mut payment, b"tunnel_cd", @0xD, 60, 3360000, &ctx);

    assert_eq!(example_multi_hop_payment::payment_total_fees(&payment), 240);
    assert_eq!(hop::route_hop_count(example_multi_hop_payment::payment_route(&payment)), 3);

    example_multi_hop_payment::destroy_for_testing(payment);
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
    let mut payment = example_multi_hop_payment::create_payment(
        &invoice,
        &clock,
        &mut ctx,
    );

    // Add route (last hop must be receiver @0x0)
    example_multi_hop_payment::add_payment_hop(
        &mut payment,
        b"sender_relay",
        @0xB,
        100,
        3600000,
        &ctx,
    );
    example_multi_hop_payment::add_payment_hop(
        &mut payment,
        b"relay_receiver",
        @0x0,
        50,
        3480000,
        &ctx,
    );

    // Validate route
    assert!(example_multi_hop_payment::validate_payment(&payment));

    // Setup HTLCs
    example_multi_hop_payment::setup_htlcs(&mut payment, 3600000, &ctx);
    assert_eq!(example_multi_hop_payment::payment_status(&payment), 1);
    assert_eq!(example_multi_hop_payment::payment_htlc_count(&payment), 2);

    // Carol claims with preimage
    let claimed = example_multi_hop_payment::claim_payment(&mut payment, preimage, &ctx);
    assert!(claimed);
    assert_eq!(example_multi_hop_payment::payment_status(&payment), 2);

    // Create receipt
    let receipt = example_multi_hop_payment::create_receipt(&payment, 1234567900);
    assert_eq!(example_multi_hop_payment::receipt_amount(&receipt), 10000);
    assert_eq!(example_multi_hop_payment::receipt_fees(&receipt), 150);
    assert_eq!(*example_multi_hop_payment::receipt_preimage(&receipt), preimage);

    example_multi_hop_payment::destroy_for_testing(payment);
    clock::destroy_for_testing(clock);
}

#[test]
fun calculate_total_needed() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let preimage = b"test";
    let invoice = example_multi_hop_payment::create_invoice(&preimage, 10000, @0xB, 3600000, b"");

    let mut payment = example_multi_hop_payment::create_payment(&invoice, &clock, &mut ctx);
    example_multi_hop_payment::add_payment_hop(&mut payment, b"tunnel", @0xB, 500, 3600000, &ctx);

    assert_eq!(example_multi_hop_payment::calculate_total_needed(&payment), 10500);

    example_multi_hop_payment::destroy_for_testing(payment);
    clock::destroy_for_testing(clock);
}

#[test]
fun payment_with_wrong_preimage() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let preimage = b"correct_preimage";
    // Receiver = @0x0 to match dummy ctx sender for claim_payment auth
    let invoice = example_multi_hop_payment::create_invoice(&preimage, 1000, @0x0, 3600000, b"");

    let mut payment = example_multi_hop_payment::create_payment(&invoice, &clock, &mut ctx);
    example_multi_hop_payment::add_payment_hop(&mut payment, b"tunnel", @0x0, 100, 3600000, &ctx);

    example_multi_hop_payment::setup_htlcs(&mut payment, 3600000, &ctx);

    // Try claiming with wrong preimage
    let claimed = example_multi_hop_payment::claim_payment(&mut payment, b"wrong_preimage", &ctx);
    assert!(!claimed);
    assert_eq!(example_multi_hop_payment::payment_status(&payment), 1);

    example_multi_hop_payment::destroy_for_testing(payment);
    clock::destroy_for_testing(clock);
}
