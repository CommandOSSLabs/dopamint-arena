#[test_only]
module sui_tunnel::example_multi_party_channel_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui_tunnel::example_multi_party_channel;
use sui_tunnel::hop;

// ============================================
// CONSTANT TESTS
// ============================================

#[test]
fun status_constants() {
    assert_eq!(example_multi_party_channel::network_open(), 0);
    assert_eq!(example_multi_party_channel::network_settling(), 1);
    assert_eq!(example_multi_party_channel::network_closed(), 2);
    assert_eq!(example_multi_party_channel::link_active(), 0);
    assert_eq!(example_multi_party_channel::link_settling(), 1);
    assert_eq!(example_multi_party_channel::link_settled(), 2);
    assert_eq!(example_multi_party_channel::link_disputed(), 3);
    assert_eq!(example_multi_party_channel::payment_pending(), 0);
    assert_eq!(example_multi_party_channel::payment_completed(), 1);
    assert_eq!(example_multi_party_channel::payment_failed(), 2);
    assert_eq!(example_multi_party_channel::max_participants(), 20);
    assert_eq!(example_multi_party_channel::max_links(), 100);
    assert_eq!(example_multi_party_channel::default_hop_timeout_ms(), 120000);
}

// ============================================
// NETWORK LIFECYCLE TESTS
// ============================================

#[test]
fun create_network() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let network = example_multi_party_channel::create_network(&clock, &mut ctx);

    assert_eq!(network.network_coordinator(), @0x0);
    assert_eq!(network.network_status(), 0);
    assert_eq!(network.network_participant_count(), 0);
    assert_eq!(network.network_link_count(), 0);
    assert_eq!(network.network_total_payments(), 0);
    assert_eq!(network.network_total_volume(), 0);

    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}

#[test]
fun register_participants() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    // Register Alice, Bob, Carol, Dave
    network.register_participant(@0xA, fee_policy, &ctx);
    network.register_participant(@0xB, fee_policy, &ctx);
    network.register_participant(@0xC, fee_policy, &ctx);
    network.register_participant(@0xD, fee_policy, &ctx);

    assert_eq!(network.network_participant_count(), 4);
    assert!(network.is_participant(@0xA));
    assert!(network.is_participant(@0xB));
    assert!(network.is_participant(@0xC));
    assert!(network.is_participant(@0xD));
    assert!(!network.is_participant(@0xE));

    // Check participant accessors
    let p0 = network.get_participant(0);
    assert_eq!(p0.participant_address(), @0xA);
    assert_eq!(p0.participant_index(), 0);

    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_multi_party_channel::EAlreadyExists,
        location = sui_tunnel::example_multi_party_channel,
    ),
]
fun register_duplicate_participant() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    network.register_participant(@0xA, fee_policy, &ctx);
    // Should fail: duplicate
    network.register_participant(@0xA, fee_policy, &ctx);

    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}

// ============================================
// LINK TESTS
// ============================================

#[test]
fun add_links() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    network.register_participant(@0xA, fee_policy, &ctx);
    network.register_participant(@0xB, fee_policy, &ctx);
    network.register_participant(@0xC, fee_policy, &ctx);
    network.register_participant(@0xD, fee_policy, &ctx);

    // Add links: A-B, B-C, C-D
    network.add_link(
        b"tunnel_ab",
        @0xA,
        @0xB,
        50000,
        50000,
        &ctx,
    );
    network.add_link(
        b"tunnel_bc",
        @0xB,
        @0xC,
        40000,
        40000,
        &ctx,
    );
    network.add_link(
        b"tunnel_cd",
        @0xC,
        @0xD,
        30000,
        30000,
        &ctx,
    );

    assert_eq!(network.network_link_count(), 3);

    // Check link accessors
    let link0 = network.get_link(0);
    assert_eq!(*link0.link_tunnel_id(), b"tunnel_ab");
    assert_eq!(link0.link_party_a(), @0xA);
    assert_eq!(link0.link_party_b(), @0xB);
    assert_eq!(link0.link_capacity_a_to_b(), 50000);
    assert_eq!(link0.link_status(), 0);

    // Find links
    let found = network.find_link_between(@0xA, @0xB);
    assert!(found.is_some());
    assert_eq!(*found.borrow(), 0);

    // Reverse order also finds the link
    let found_rev = network.find_link_between(@0xB, @0xA);
    assert!(found_rev.is_some());

    // Non-existent link
    let not_found = network.find_link_between(@0xA, @0xD);
    assert!(not_found.is_none());

    assert_eq!(network.count_active_links(), 3);

    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}

#[test]
fun update_link_capacity() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    network.register_participant(@0xA, fee_policy, &ctx);
    network.register_participant(@0xB, fee_policy, &ctx);
    network.add_link(
        b"tunnel_ab",
        @0xA,
        @0xB,
        50000,
        50000,
        &ctx,
    );

    network.update_link_capacity(0, 70000, 30000, &ctx);

    let link = network.get_link(0);
    assert_eq!(link.link_capacity_a_to_b(), 70000);
    assert_eq!(link.link_capacity_b_to_a(), 30000);

    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}

// ============================================
// PAYMENT ROUTING TESTS
// ============================================

#[test]
fun route_payment_three_hops() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    // Register participants: sender @0x0 (dummy ctx), B, C, D
    network.register_participant(@0x0, fee_policy, &ctx);
    network.register_participant(@0xB, fee_policy, &ctx);
    network.register_participant(@0xC, fee_policy, &ctx);
    network.register_participant(@0xD, fee_policy, &ctx);

    // Add links
    network.add_link(
        b"tunnel_0b",
        @0x0,
        @0xB,
        100000,
        100000,
        &ctx,
    );
    network.add_link(
        b"tunnel_bc",
        @0xB,
        @0xC,
        80000,
        80000,
        &ctx,
    );
    network.add_link(
        b"tunnel_cd",
        @0xC,
        @0xD,
        60000,
        60000,
        &ctx,
    );

    // Create payment from sender to Dave
    let preimage = b"multi_party_secret_preimage";
    let payment_hash = example_multi_party_channel::create_payment_hash(&preimage);

    let mut payment = network.create_routed_payment(
        @0xD,
        10000,
        payment_hash,
        &clock,
        &mut ctx,
    );

    assert_eq!(payment.routed_payment_status(), 0);
    assert_eq!(payment.routed_payment_amount(), 10000);
    assert_eq!(payment.routed_payment_source(), @0x0);
    assert_eq!(payment.routed_payment_destination(), @0xD);

    // Add hops: 0x0 -> B -> C -> D (with decreasing timeouts)
    payment.add_routing_hop(
        &network,
        0,
        @0xB,
        100,
        600000,
    );
    payment.add_routing_hop(
        &network,
        1,
        @0xC,
        80,
        480000,
    );
    payment.add_routing_hop(
        &network,
        2,
        @0xD,
        60,
        360000,
    );

    assert_eq!(payment.routed_payment_total_fees(), 240);

    // Activate payment
    payment.activate_payment(&mut network, 600000);

    assert_eq!(payment.routed_payment_htlc_count(), 3);
    assert_eq!(network.network_total_payments(), 1);
    assert_eq!(network.network_total_volume(), 10000);

    // Claim with preimage
    let claimed = payment.claim_routed_payment(preimage);
    assert!(claimed);
    assert_eq!(payment.routed_payment_status(), 1);
    assert_eq!(payment.routed_payment_settled_count(), 3);

    // Create receipt
    let receipt = payment.create_payment_receipt(1000000);
    assert_eq!(receipt.receipt_amount(), 10000);
    assert_eq!(receipt.receipt_fees(), 240);
    assert_eq!(receipt.receipt_hop_count(), 3);
    assert_eq!(receipt.receipt_source(), @0x0);
    assert_eq!(receipt.receipt_destination(), @0xD);

    payment.destroy_payment_for_testing();
    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}

#[test]
fun payment_wrong_preimage() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    network.register_participant(@0x0, fee_policy, &ctx);
    network.register_participant(@0xB, fee_policy, &ctx);

    network.add_link(
        b"tunnel_0b",
        @0x0,
        @0xB,
        100000,
        100000,
        &ctx,
    );

    let preimage = b"correct_preimage";
    let payment_hash = example_multi_party_channel::create_payment_hash(&preimage);

    let mut payment = network.create_routed_payment(
        @0xB,
        5000,
        payment_hash,
        &clock,
        &mut ctx,
    );

    payment.add_routing_hop(
        &network,
        0,
        @0xB,
        50,
        600000,
    );
    payment.activate_payment(&mut network, 600000);

    // Try wrong preimage
    let claimed = payment.claim_routed_payment(
        b"wrong_preimage",
    );
    assert!(!claimed);
    // Status should remain unchanged (still in PENDING since activate doesn't change to a different status)
    // Actually, after activate_payment the route is ACTIVE but payment status stays PENDING
    // until claimed. Let me check - the status stays PAYMENT_PENDING until claimed.

    payment.destroy_payment_for_testing();
    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}

// ============================================
// DISPUTE ISOLATION TESTS
// ============================================

#[test]
fun dispute_isolation() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    network.register_participant(@0x0, fee_policy, &ctx);
    network.register_participant(@0xB, fee_policy, &ctx);
    network.register_participant(@0xC, fee_policy, &ctx);
    network.register_participant(@0xD, fee_policy, &ctx);

    // Add three links
    network.add_link(
        b"tunnel_0b",
        @0x0,
        @0xB,
        50000,
        50000,
        &ctx,
    );
    network.add_link(
        b"tunnel_bc",
        @0xB,
        @0xC,
        40000,
        40000,
        &ctx,
    );
    network.add_link(
        b"tunnel_cd",
        @0xC,
        @0xD,
        30000,
        30000,
        &ctx,
    );

    // Dispute the B-C link (coordinator @0x0 can dispute)
    network.mark_link_disputed(1, &ctx);

    // Verify: link 1 is disputed, links 0 and 2 remain active
    let link0 = network.get_link(0);
    let link1 = network.get_link(1);
    let link2 = network.get_link(2);

    assert_eq!(link0.link_status(), 0); // ACTIVE
    assert_eq!(link1.link_status(), 3); // DISPUTED
    assert_eq!(link2.link_status(), 0); // ACTIVE

    assert_eq!(network.count_active_links(), 2);

    // Can still route a payment through non-disputed links (0 -> B, using link 0)
    let preimage = b"dispute_test_preimage";
    let payment_hash = example_multi_party_channel::create_payment_hash(&preimage);

    let mut payment = network.create_routed_payment(
        @0xB,
        1000,
        payment_hash,
        &clock,
        &mut ctx,
    );

    payment.add_routing_hop(
        &network,
        0,
        @0xB,
        10,
        600000,
    );
    payment.activate_payment(&mut network, 600000);

    let claimed = payment.claim_routed_payment(preimage);
    assert!(claimed);

    // Resolve the dispute
    let settlement = network.resolve_link_dispute(
        1,
        20000,
        20000,
        &ctx,
    );
    assert_eq!(settlement.settlement_party_a_final(), 20000);

    // Link 1 is now settled
    let link1_after = network.get_link(1);
    assert_eq!(link1_after.link_status(), 2); // SETTLED

    payment.destroy_payment_for_testing();
    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}

// ============================================
// SETTLEMENT TESTS
// ============================================

#[test]
fun settle_individual_link() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    network.register_participant(@0xA, fee_policy, &ctx);
    network.register_participant(@0xB, fee_policy, &ctx);
    network.register_participant(@0xC, fee_policy, &ctx);

    network.add_link(
        b"tunnel_ab",
        @0xA,
        @0xB,
        50000,
        50000,
        &ctx,
    );
    network.add_link(
        b"tunnel_bc",
        @0xB,
        @0xC,
        40000,
        40000,
        &ctx,
    );

    // Begin settlement on link 0
    network.begin_link_settlement(0, &ctx);
    let link0 = network.get_link(0);
    assert_eq!(link0.link_status(), 1); // SETTLING

    // Link 1 remains active
    let link1 = network.get_link(1);
    assert_eq!(link1.link_status(), 0); // ACTIVE

    // Settle link 0
    let settlement = network.settle_link(
        0,
        25000,
        25000,
        &ctx,
    );
    assert_eq!(*settlement.settlement_tunnel_id(), b"tunnel_ab");
    assert_eq!(settlement.settlement_party_a_final(), 25000);
    assert_eq!(settlement.settlement_party_b_final(), 25000);

    let link0_after = network.get_link(0);
    assert_eq!(link0_after.link_status(), 2); // SETTLED

    assert_eq!(network.count_settled_links(), 1);
    assert_eq!(network.count_active_links(), 1);

    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}

#[test]
fun network_settlement_flow() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    network.register_participant(@0xA, fee_policy, &ctx);
    network.register_participant(@0xB, fee_policy, &ctx);

    network.add_link(
        b"tunnel_ab",
        @0xA,
        @0xB,
        50000,
        50000,
        &ctx,
    );

    // Begin network settlement
    network.begin_network_settlement(&ctx);
    assert_eq!(network.network_status(), 1); // SETTLING

    // Settle the link
    network.settle_link(0, 25000, 25000, &ctx);

    // Close network
    network.close_network(&ctx);
    assert_eq!(network.network_status(), 2); // CLOSED

    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_multi_party_channel::EInvalidState,
        location = sui_tunnel::example_multi_party_channel,
    ),
]
fun cannot_add_link_when_settling() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    network.register_participant(@0xA, fee_policy, &ctx);
    network.register_participant(@0xB, fee_policy, &ctx);

    network.begin_network_settlement(&ctx);

    // Should fail: network is settling
    network.add_link(
        b"tunnel_ab",
        @0xA,
        @0xB,
        50000,
        50000,
        &ctx,
    );

    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_multi_party_channel::EInvalidState,
        location = sui_tunnel::example_multi_party_channel,
    ),
]
fun cannot_close_with_unsettled_links() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    network.register_participant(@0xA, fee_policy, &ctx);
    network.register_participant(@0xB, fee_policy, &ctx);

    network.add_link(
        b"tunnel_ab",
        @0xA,
        @0xB,
        50000,
        50000,
        &ctx,
    );

    network.begin_network_settlement(&ctx);

    // Should fail: link not yet settled
    network.close_network(&ctx);

    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}

// ============================================
// FULL FLOW TEST
// ============================================

#[test]
fun full_network_lifecycle() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    // 1. Create network
    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    // 2. Register 4 participants (sender is @0x0 from dummy ctx)
    network.register_participant(@0x0, fee_policy, &ctx);
    network.register_participant(@0xB, fee_policy, &ctx);
    network.register_participant(@0xC, fee_policy, &ctx);
    network.register_participant(@0xD, fee_policy, &ctx);

    // 3. Add links forming a chain: 0x0 - B - C - D
    network.add_link(
        b"tun_0b",
        @0x0,
        @0xB,
        100000,
        100000,
        &ctx,
    );
    network.add_link(
        b"tun_bc",
        @0xB,
        @0xC,
        80000,
        80000,
        &ctx,
    );
    network.add_link(
        b"tun_cd",
        @0xC,
        @0xD,
        60000,
        60000,
        &ctx,
    );

    // 4. Route payment from 0x0 to D through B and C
    let preimage = b"full_flow_preimage";
    let payment_hash = example_multi_party_channel::create_payment_hash(&preimage);

    let mut payment = network.create_routed_payment(
        @0xD,
        5000,
        payment_hash,
        &clock,
        &mut ctx,
    );

    payment.add_routing_hop(&network, 0, @0xB, 100, 600000);
    payment.add_routing_hop(&network, 1, @0xC, 80, 480000);
    payment.add_routing_hop(&network, 2, @0xD, 60, 360000);

    payment.activate_payment(&mut network, 600000);
    let claimed = payment.claim_routed_payment(preimage);
    assert!(claimed);

    // 5. Begin settlement
    network.begin_network_settlement(&ctx);

    // 6. Settle all links
    network.settle_link(0, 45000, 55000, &ctx);
    network.settle_link(1, 38000, 42000, &ctx);
    network.settle_link(2, 28000, 32000, &ctx);

    // 7. Close network
    network.close_network(&ctx);
    assert_eq!(network.network_status(), 2);
    assert_eq!(network.network_total_payments(), 1);
    assert_eq!(network.network_total_volume(), 5000);
    assert!(network.all_links_settled());

    payment.destroy_payment_for_testing();
    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}

#[test]
// REPRO #6: the route source must be able to fail/unwind a >=2-hop payment after timeout.
// Intermediary HTLCs have non-source senders; previously the sender-gated hop::expire_htlc
// aborted ENotAuthorized on the first such hop, so this whole call reverted.
fun fail_routed_payment_unwinds_multi_hop_htlcs() {
    let mut ctx = sui::tx_context::dummy(); // sender is @0x0 = route source
    let mut clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();
    network.register_participant(@0x0, fee_policy, &ctx);
    network.register_participant(@0xB, fee_policy, &ctx);
    network.register_participant(@0xC, fee_policy, &ctx);
    network.register_participant(@0xD, fee_policy, &ctx);
    network.add_link(
        b"tun_0b",
        @0x0,
        @0xB,
        100000,
        100000,
        &ctx,
    );
    network.add_link(b"tun_bc", @0xB, @0xC, 80000, 80000, &ctx);
    network.add_link(b"tun_cd", @0xC, @0xD, 60000, 60000, &ctx);

    let payment_hash = example_multi_party_channel::create_payment_hash(&b"unwind_preimage");
    let mut payment = network.create_routed_payment(
        @0xD,
        5000,
        payment_hash,
        &clock,
        &mut ctx,
    );
    // HTLC[1].sender = @0xB and HTLC[2].sender = @0xC — neither is the source @0x0.
    payment.add_routing_hop(&network, 0, @0xB, 100, 600000);
    payment.add_routing_hop(&network, 1, @0xC, 80, 480000);
    payment.add_routing_hop(&network, 2, @0xD, 60, 360000);
    payment.activate_payment(&mut network, 600000);

    // Past every HTLC expiry; the source unwinds. Must NOT abort and must mark the payment failed.
    clock::increment_for_testing(&mut clock, 10_000_000);
    payment.fail_routed_payment(&clock, &ctx);
    assert_eq!(payment.routed_payment_status(), example_multi_party_channel::payment_failed());

    payment.destroy_payment_for_testing();
    network.destroy_network_for_testing();
    clock::destroy_for_testing(clock);
}
