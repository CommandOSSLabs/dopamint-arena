#[test_only]
module sui_tunnel::example_multi_party_channel_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::sui::SUI;
use sui_tunnel::example_multi_party_channel;
use sui_tunnel::hop;
use sui_tunnel::tunnel;

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

    assert_eq!(example_multi_party_channel::network_coordinator(&network), @0x0);
    assert_eq!(example_multi_party_channel::network_status(&network), 0);
    assert_eq!(example_multi_party_channel::network_participant_count(&network), 0);
    assert_eq!(example_multi_party_channel::network_link_count(&network), 0);
    assert_eq!(example_multi_party_channel::network_total_payments(&network), 0);
    assert_eq!(example_multi_party_channel::network_total_volume(&network), 0);

    example_multi_party_channel::destroy_network_for_testing(network);
    clock::destroy_for_testing(clock);
}

#[test]
fun register_participants() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    // Register Alice, Bob, Carol, Dave
    example_multi_party_channel::register_participant(&mut network, @0xA, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xC, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xD, fee_policy, &ctx);

    assert_eq!(example_multi_party_channel::network_participant_count(&network), 4);
    assert!(example_multi_party_channel::is_participant(&network, @0xA));
    assert!(example_multi_party_channel::is_participant(&network, @0xB));
    assert!(example_multi_party_channel::is_participant(&network, @0xC));
    assert!(example_multi_party_channel::is_participant(&network, @0xD));
    assert!(!example_multi_party_channel::is_participant(&network, @0xE));

    // Check participant accessors
    let p0 = example_multi_party_channel::get_participant(&network, 0);
    assert_eq!(example_multi_party_channel::participant_address(p0), @0xA);
    assert_eq!(example_multi_party_channel::participant_index(p0), 0);

    example_multi_party_channel::destroy_network_for_testing(network);
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

    example_multi_party_channel::register_participant(&mut network, @0xA, fee_policy, &ctx);
    // Should fail: duplicate
    example_multi_party_channel::register_participant(&mut network, @0xA, fee_policy, &ctx);

    example_multi_party_channel::destroy_network_for_testing(network);
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

    example_multi_party_channel::register_participant(&mut network, @0xA, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xC, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xD, fee_policy, &ctx);

    // Add links: A-B, B-C, C-D
    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_ab",
        @0xA,
        @0xB,
        50000,
        50000,
        &ctx,
    );
    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_bc",
        @0xB,
        @0xC,
        40000,
        40000,
        &ctx,
    );
    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_cd",
        @0xC,
        @0xD,
        30000,
        30000,
        &ctx,
    );

    assert_eq!(example_multi_party_channel::network_link_count(&network), 3);

    // Check link accessors
    let link0 = example_multi_party_channel::get_link(&network, 0);
    assert_eq!(*example_multi_party_channel::link_tunnel_id(link0), b"tunnel_ab");
    assert_eq!(example_multi_party_channel::link_party_a(link0), @0xA);
    assert_eq!(example_multi_party_channel::link_party_b(link0), @0xB);
    assert_eq!(example_multi_party_channel::link_capacity_a_to_b(link0), 50000);
    assert_eq!(example_multi_party_channel::link_status(link0), 0);

    // Find links
    let found = example_multi_party_channel::find_link_between(&network, @0xA, @0xB);
    assert!(found.is_some());
    assert_eq!(*found.borrow(), 0);

    // Reverse order also finds the link
    let found_rev = example_multi_party_channel::find_link_between(&network, @0xB, @0xA);
    assert!(found_rev.is_some());

    // Non-existent link
    let not_found = example_multi_party_channel::find_link_between(&network, @0xA, @0xD);
    assert!(not_found.is_none());

    assert_eq!(example_multi_party_channel::count_active_links(&network), 3);

    example_multi_party_channel::destroy_network_for_testing(network);
    clock::destroy_for_testing(clock);
}

#[test]
fun update_link_capacity() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    example_multi_party_channel::register_participant(&mut network, @0xA, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);
    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_ab",
        @0xA,
        @0xB,
        50000,
        50000,
        &ctx,
    );

    example_multi_party_channel::update_link_capacity(&mut network, 0, 70000, 30000, &ctx);

    let link = example_multi_party_channel::get_link(&network, 0);
    assert_eq!(example_multi_party_channel::link_capacity_a_to_b(link), 70000);
    assert_eq!(example_multi_party_channel::link_capacity_b_to_a(link), 30000);

    example_multi_party_channel::destroy_network_for_testing(network);
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
    example_multi_party_channel::register_participant(&mut network, @0x0, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xC, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xD, fee_policy, &ctx);

    // Add links
    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_0b",
        @0x0,
        @0xB,
        100000,
        100000,
        &ctx,
    );
    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_bc",
        @0xB,
        @0xC,
        80000,
        80000,
        &ctx,
    );
    example_multi_party_channel::add_link(
        &mut network,
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

    let mut payment = example_multi_party_channel::create_routed_payment(
        &network,
        @0xD,
        10000,
        payment_hash,
        &clock,
        &mut ctx,
    );

    assert_eq!(example_multi_party_channel::routed_payment_status(&payment), 0);
    assert_eq!(example_multi_party_channel::routed_payment_amount(&payment), 10000);
    assert_eq!(example_multi_party_channel::routed_payment_source(&payment), @0x0);
    assert_eq!(example_multi_party_channel::routed_payment_destination(&payment), @0xD);

    // Add hops: 0x0 -> B -> C -> D (with decreasing timeouts)
    example_multi_party_channel::add_routing_hop(
        &mut payment,
        &network,
        0,
        @0xB,
        100,
        600000,
    );
    example_multi_party_channel::add_routing_hop(
        &mut payment,
        &network,
        1,
        @0xC,
        80,
        480000,
    );
    example_multi_party_channel::add_routing_hop(
        &mut payment,
        &network,
        2,
        @0xD,
        60,
        360000,
    );

    assert_eq!(example_multi_party_channel::routed_payment_total_fees(&payment), 240);

    // Activate payment
    example_multi_party_channel::activate_payment(&mut payment, &mut network, 600000);

    assert_eq!(example_multi_party_channel::routed_payment_htlc_count(&payment), 3);
    assert_eq!(example_multi_party_channel::network_total_payments(&network), 1);
    assert_eq!(example_multi_party_channel::network_total_volume(&network), 10000);

    // Claim with preimage
    let claimed = example_multi_party_channel::claim_routed_payment(&mut payment, preimage);
    assert!(claimed);
    assert_eq!(example_multi_party_channel::routed_payment_status(&payment), 1);
    assert_eq!(example_multi_party_channel::routed_payment_settled_count(&payment), 3);

    // Create receipt
    let receipt = example_multi_party_channel::create_payment_receipt(&payment, 1000000);
    assert_eq!(example_multi_party_channel::receipt_amount(&receipt), 10000);
    assert_eq!(example_multi_party_channel::receipt_fees(&receipt), 240);
    assert_eq!(example_multi_party_channel::receipt_hop_count(&receipt), 3);
    assert_eq!(example_multi_party_channel::receipt_source(&receipt), @0x0);
    assert_eq!(example_multi_party_channel::receipt_destination(&receipt), @0xD);

    example_multi_party_channel::destroy_payment_for_testing(payment);
    example_multi_party_channel::destroy_network_for_testing(network);
    clock::destroy_for_testing(clock);
}

#[test]
fun payment_wrong_preimage() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    example_multi_party_channel::register_participant(&mut network, @0x0, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);

    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_0b",
        @0x0,
        @0xB,
        100000,
        100000,
        &ctx,
    );

    let preimage = b"correct_preimage";
    let payment_hash = example_multi_party_channel::create_payment_hash(&preimage);

    let mut payment = example_multi_party_channel::create_routed_payment(
        &network,
        @0xB,
        5000,
        payment_hash,
        &clock,
        &mut ctx,
    );

    example_multi_party_channel::add_routing_hop(
        &mut payment,
        &network,
        0,
        @0xB,
        50,
        600000,
    );
    example_multi_party_channel::activate_payment(&mut payment, &mut network, 600000);

    // Try wrong preimage
    let claimed = example_multi_party_channel::claim_routed_payment(
        &mut payment,
        b"wrong_preimage",
    );
    assert!(!claimed);
    // Status should remain unchanged (still in PENDING since activate doesn't change to a different status)
    // Actually, after activate_payment the route is ACTIVE but payment status stays PENDING
    // until claimed. Let me check - the status stays PAYMENT_PENDING until claimed.

    example_multi_party_channel::destroy_payment_for_testing(payment);
    example_multi_party_channel::destroy_network_for_testing(network);
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

    example_multi_party_channel::register_participant(&mut network, @0x0, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xC, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xD, fee_policy, &ctx);

    // Add three links
    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_0b",
        @0x0,
        @0xB,
        50000,
        50000,
        &ctx,
    );
    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_bc",
        @0xB,
        @0xC,
        40000,
        40000,
        &ctx,
    );
    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_cd",
        @0xC,
        @0xD,
        30000,
        30000,
        &ctx,
    );

    // Dispute the B-C link (coordinator @0x0 can dispute)
    example_multi_party_channel::mark_link_disputed(&mut network, 1, &ctx);

    // Verify: link 1 is disputed, links 0 and 2 remain active
    let link0 = example_multi_party_channel::get_link(&network, 0);
    let link1 = example_multi_party_channel::get_link(&network, 1);
    let link2 = example_multi_party_channel::get_link(&network, 2);

    assert_eq!(example_multi_party_channel::link_status(link0), 0); // ACTIVE
    assert_eq!(example_multi_party_channel::link_status(link1), 3); // DISPUTED
    assert_eq!(example_multi_party_channel::link_status(link2), 0); // ACTIVE

    assert_eq!(example_multi_party_channel::count_active_links(&network), 2);

    // Can still route a payment through non-disputed links (0 -> B, using link 0)
    let preimage = b"dispute_test_preimage";
    let payment_hash = example_multi_party_channel::create_payment_hash(&preimage);

    let mut payment = example_multi_party_channel::create_routed_payment(
        &network,
        @0xB,
        1000,
        payment_hash,
        &clock,
        &mut ctx,
    );

    example_multi_party_channel::add_routing_hop(
        &mut payment,
        &network,
        0,
        @0xB,
        10,
        600000,
    );
    example_multi_party_channel::activate_payment(&mut payment, &mut network, 600000);

    let claimed = example_multi_party_channel::claim_routed_payment(&mut payment, preimage);
    assert!(claimed);

    // Resolve the dispute (finals conserve the link's 80000 capacity sum)
    let settlement = example_multi_party_channel::resolve_link_dispute(
        &mut network,
        1,
        50000,
        30000,
        &ctx,
    );
    assert_eq!(example_multi_party_channel::settlement_party_a_final(&settlement), 50000);

    // Link 1 is now settled
    let link1_after = example_multi_party_channel::get_link(&network, 1);
    assert_eq!(example_multi_party_channel::link_status(link1_after), 2); // SETTLED

    example_multi_party_channel::destroy_payment_for_testing(payment);
    example_multi_party_channel::destroy_network_for_testing(network);
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

    example_multi_party_channel::register_participant(&mut network, @0xA, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xC, fee_policy, &ctx);

    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_ab",
        @0xA,
        @0xB,
        50000,
        50000,
        &ctx,
    );
    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_bc",
        @0xB,
        @0xC,
        40000,
        40000,
        &ctx,
    );

    // Begin settlement on link 0
    example_multi_party_channel::begin_link_settlement(&mut network, 0, &ctx);
    let link0 = example_multi_party_channel::get_link(&network, 0);
    assert_eq!(example_multi_party_channel::link_status(link0), 1); // SETTLING

    // Link 1 remains active
    let link1 = example_multi_party_channel::get_link(&network, 1);
    assert_eq!(example_multi_party_channel::link_status(link1), 0); // ACTIVE

    // Settle link 0 (finals conserve the link's 100000 capacity sum)
    let settlement = example_multi_party_channel::settle_link(
        &mut network,
        0,
        60000,
        40000,
        &ctx,
    );
    assert_eq!(*example_multi_party_channel::settlement_tunnel_id(&settlement), b"tunnel_ab");
    assert_eq!(example_multi_party_channel::settlement_party_a_final(&settlement), 60000);
    assert_eq!(example_multi_party_channel::settlement_party_b_final(&settlement), 40000);

    let link0_after = example_multi_party_channel::get_link(&network, 0);
    assert_eq!(example_multi_party_channel::link_status(link0_after), 2); // SETTLED

    assert_eq!(example_multi_party_channel::count_settled_links(&network), 1);
    assert_eq!(example_multi_party_channel::count_active_links(&network), 1);

    example_multi_party_channel::destroy_network_for_testing(network);
    clock::destroy_for_testing(clock);
}

#[test]
fun network_settlement_flow() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();

    example_multi_party_channel::register_participant(&mut network, @0xA, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);

    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_ab",
        @0xA,
        @0xB,
        50000,
        50000,
        &ctx,
    );

    // Begin network settlement
    example_multi_party_channel::begin_network_settlement(&mut network, &ctx);
    assert_eq!(example_multi_party_channel::network_status(&network), 1); // SETTLING

    // Settle the link (finals conserve the link's 100000 capacity sum)
    example_multi_party_channel::settle_link(&mut network, 0, 50000, 50000, &ctx);

    // Close network
    example_multi_party_channel::close_network(&mut network, &ctx);
    assert_eq!(example_multi_party_channel::network_status(&network), 2); // CLOSED

    example_multi_party_channel::destroy_network_for_testing(network);
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

    example_multi_party_channel::register_participant(&mut network, @0xA, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);

    example_multi_party_channel::begin_network_settlement(&mut network, &ctx);

    // Should fail: network is settling
    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_ab",
        @0xA,
        @0xB,
        50000,
        50000,
        &ctx,
    );

    example_multi_party_channel::destroy_network_for_testing(network);
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

    example_multi_party_channel::register_participant(&mut network, @0xA, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);

    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_ab",
        @0xA,
        @0xB,
        50000,
        50000,
        &ctx,
    );

    example_multi_party_channel::begin_network_settlement(&mut network, &ctx);

    // Should fail: link not yet settled
    example_multi_party_channel::close_network(&mut network, &ctx);

    example_multi_party_channel::destroy_network_for_testing(network);
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
    example_multi_party_channel::register_participant(&mut network, @0x0, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xC, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xD, fee_policy, &ctx);

    // 3. Add links forming a chain: 0x0 - B - C - D
    example_multi_party_channel::add_link(
        &mut network,
        b"tun_0b",
        @0x0,
        @0xB,
        100000,
        100000,
        &ctx,
    );
    example_multi_party_channel::add_link(
        &mut network,
        b"tun_bc",
        @0xB,
        @0xC,
        80000,
        80000,
        &ctx,
    );
    example_multi_party_channel::add_link(
        &mut network,
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

    let mut payment = example_multi_party_channel::create_routed_payment(
        &network,
        @0xD,
        5000,
        payment_hash,
        &clock,
        &mut ctx,
    );

    example_multi_party_channel::add_routing_hop(&mut payment, &network, 0, @0xB, 100, 600000);
    example_multi_party_channel::add_routing_hop(&mut payment, &network, 1, @0xC, 80, 480000);
    example_multi_party_channel::add_routing_hop(&mut payment, &network, 2, @0xD, 60, 360000);

    example_multi_party_channel::activate_payment(&mut payment, &mut network, 600000);
    let claimed = example_multi_party_channel::claim_routed_payment(&mut payment, preimage);
    assert!(claimed);

    // 5. Begin settlement
    example_multi_party_channel::begin_network_settlement(&mut network, &ctx);

    // 6. Settle all links (finals conserve each link's capacity sum)
    example_multi_party_channel::settle_link(&mut network, 0, 120000, 80000, &ctx);
    example_multi_party_channel::settle_link(&mut network, 1, 90000, 70000, &ctx);
    example_multi_party_channel::settle_link(&mut network, 2, 70000, 50000, &ctx);

    // 7. Close network
    example_multi_party_channel::close_network(&mut network, &ctx);
    assert_eq!(example_multi_party_channel::network_status(&network), 2);
    assert_eq!(example_multi_party_channel::network_total_payments(&network), 1);
    assert_eq!(example_multi_party_channel::network_total_volume(&network), 5000);
    assert!(example_multi_party_channel::all_links_settled(&network));

    example_multi_party_channel::destroy_payment_for_testing(payment);
    example_multi_party_channel::destroy_network_for_testing(network);
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
    example_multi_party_channel::register_participant(&mut network, @0x0, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xC, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xD, fee_policy, &ctx);
    example_multi_party_channel::add_link(
        &mut network,
        b"tun_0b",
        @0x0,
        @0xB,
        100000,
        100000,
        &ctx,
    );
    example_multi_party_channel::add_link(
        &mut network,
        b"tun_bc",
        @0xB,
        @0xC,
        80000,
        80000,
        &ctx,
    );
    example_multi_party_channel::add_link(
        &mut network,
        b"tun_cd",
        @0xC,
        @0xD,
        60000,
        60000,
        &ctx,
    );

    let payment_hash = example_multi_party_channel::create_payment_hash(&b"unwind_preimage");
    let mut payment = example_multi_party_channel::create_routed_payment(
        &network,
        @0xD,
        5000,
        payment_hash,
        &clock,
        &mut ctx,
    );
    // HTLC[1].sender = @0xB and HTLC[2].sender = @0xC — neither is the source @0x0.
    example_multi_party_channel::add_routing_hop(&mut payment, &network, 0, @0xB, 100, 600000);
    example_multi_party_channel::add_routing_hop(&mut payment, &network, 1, @0xC, 80, 480000);
    example_multi_party_channel::add_routing_hop(&mut payment, &network, 2, @0xD, 60, 360000);
    example_multi_party_channel::activate_payment(&mut payment, &mut network, 600000);

    // Past every HTLC expiry; the source unwinds. Must NOT abort and must mark the payment failed.
    clock::increment_for_testing(&mut clock, 10_000_000);
    example_multi_party_channel::fail_routed_payment(&mut payment, &clock, &ctx);
    assert_eq!(
        example_multi_party_channel::routed_payment_status(&payment),
        example_multi_party_channel::payment_failed(),
    );

    example_multi_party_channel::destroy_payment_for_testing(payment);
    example_multi_party_channel::destroy_network_for_testing(network);
    clock::destroy_for_testing(clock);
}

// ============================================
// REAL-TUNNEL BINDING
// ============================================

const P_A: address = @0xA;
const P_B: address = @0xB;

/// A network whose coordinator is the dummy-ctx sender (@0x0), with P_A and P_B
/// registered as participants.
fun network_with_participants(
    clock: &clock::Clock,
    ctx: &mut TxContext,
): example_multi_party_channel::ChannelNetwork {
    let mut network = example_multi_party_channel::create_network(clock, ctx);
    let fee_policy = hop::default_fee_policy();
    example_multi_party_channel::register_participant(&mut network, P_A, fee_policy, ctx);
    example_multi_party_channel::register_participant(&mut network, P_B, fee_policy, ctx);
    network
}

#[test]
fun add_link_for_tunnel_binds_real_tunnel() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = network_with_participants(&clock, &mut ctx);
    let tun = tunnel::create_active_for_testing<SUI>(
        P_A,
        P_B,
        1500,
        500,
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    example_multi_party_channel::add_link_for_tunnel(&mut network, &tun, &ctx);

    assert_eq!(example_multi_party_channel::network_link_count(&network), 1);
    let link = example_multi_party_channel::get_link(&network, 0);
    assert_eq!(example_multi_party_channel::link_party_a(link), P_A);
    assert_eq!(example_multi_party_channel::link_party_b(link), P_B);
    // Capacities are derived from the live tunnel state, not caller input.
    assert_eq!(example_multi_party_channel::link_capacity_a_to_b(link), 1500);
    assert_eq!(example_multi_party_channel::link_capacity_b_to_a(link), 500);
    assert_eq!(*example_multi_party_channel::link_tunnel_id(link), tun.id().to_bytes());

    tunnel::destroy_for_testing(tun);
    example_multi_party_channel::destroy_network_for_testing(network);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_multi_party_channel::ENotFound,
        location = sui_tunnel::example_multi_party_channel,
    ),
]
fun add_link_for_tunnel_rejects_unregistered_party() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = network_with_participants(&clock, &mut ctx);
    // P_B is registered, @0xE is not.
    let tun = tunnel::create_active_for_testing<SUI>(
        P_B,
        @0xE,
        1500,
        500,
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    example_multi_party_channel::add_link_for_tunnel(&mut network, &tun, &ctx);

    // Unreachable; present so the test type-checks.
    tunnel::destroy_for_testing(tun);
    example_multi_party_channel::destroy_network_for_testing(network);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_multi_party_channel::EAlreadyExists,
        location = sui_tunnel::example_multi_party_channel,
    ),
]
fun add_link_for_tunnel_rejects_duplicate_link() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = network_with_participants(&clock, &mut ctx);
    let first = tunnel::create_active_for_testing<SUI>(
        P_A,
        P_B,
        1500,
        500,
        3600000,
        0,
        &clock,
        &mut ctx,
    );
    example_multi_party_channel::add_link_for_tunnel(&mut network, &first, &ctx);

    // A second tunnel between the same parties is a duplicate link.
    let second = tunnel::create_active_for_testing<SUI>(
        P_A,
        P_B,
        1000,
        1000,
        3600000,
        0,
        &clock,
        &mut ctx,
    );
    example_multi_party_channel::add_link_for_tunnel(&mut network, &second, &ctx);

    // Unreachable; present so the test type-checks.
    tunnel::destroy_for_testing(first);
    tunnel::destroy_for_testing(second);
    example_multi_party_channel::destroy_network_for_testing(network);
    clock::destroy_for_testing(clock);
}

#[test]
fun settle_link_checked_records_conserving_split() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = network_with_participants(&clock, &mut ctx);
    let tun = tunnel::create_active_for_testing<SUI>(
        P_A,
        P_B,
        1500,
        500,
        3600000,
        0,
        &clock,
        &mut ctx,
    );
    example_multi_party_channel::add_link_for_tunnel(&mut network, &tun, &ctx);

    // A split that conserves the 2000 total is accepted (the real transfer would run
    // inside the tunnel via close_cooperative_and_transfer).
    let settlement = example_multi_party_channel::settle_link_checked(
        &mut network,
        &tun,
        0,
        1200,
        800,
        &ctx,
    );
    assert_eq!(example_multi_party_channel::settlement_party_a_final(&settlement), 1200);
    assert_eq!(example_multi_party_channel::settlement_party_b_final(&settlement), 800);
    assert_eq!(
        example_multi_party_channel::link_status(
            example_multi_party_channel::get_link(&network, 0),
        ),
        example_multi_party_channel::link_settled(),
    );

    tunnel::destroy_for_testing(tun);
    example_multi_party_channel::destroy_network_for_testing(network);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_multi_party_channel::EBalanceSumMismatch,
        location = sui_tunnel::example_multi_party_channel,
    ),
]
fun settle_link_checked_rejects_non_conserving_split() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = network_with_participants(&clock, &mut ctx);
    let tun = tunnel::create_active_for_testing<SUI>(
        P_A,
        P_B,
        1500,
        500,
        3600000,
        0,
        &clock,
        &mut ctx,
    );
    example_multi_party_channel::add_link_for_tunnel(&mut network, &tun, &ctx);

    // 1000 + 500 = 1500, not the 2000 held by the tunnel.
    let _ = example_multi_party_channel::settle_link_checked(
        &mut network,
        &tun,
        0,
        1000,
        500,
        &ctx,
    );

    // Unreachable; present so the test type-checks.
    tunnel::destroy_for_testing(tun);
    example_multi_party_channel::destroy_network_for_testing(network);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_multi_party_channel::ELinkTunnelMismatch,
        location = sui_tunnel::example_multi_party_channel,
    ),
]
fun settle_link_checked_rejects_wrong_tunnel() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = network_with_participants(&clock, &mut ctx);
    let linked = tunnel::create_active_for_testing<SUI>(
        P_A,
        P_B,
        1500,
        500,
        3600000,
        0,
        &clock,
        &mut ctx,
    );
    example_multi_party_channel::add_link_for_tunnel(&mut network, &linked, &ctx);

    // A different tunnel with the same parties and total balance, but a different id.
    let other = tunnel::create_active_for_testing<SUI>(
        P_A,
        P_B,
        1000,
        1000,
        3600000,
        0,
        &clock,
        &mut ctx,
    );
    let _ = example_multi_party_channel::settle_link_checked(
        &mut network,
        &other,
        0,
        1500,
        500,
        &ctx,
    );

    // Unreachable; present so the test type-checks.
    tunnel::destroy_for_testing(linked);
    tunnel::destroy_for_testing(other);
    example_multi_party_channel::destroy_network_for_testing(network);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_multi_party_channel::EBalanceSumMismatch,
        location = sui_tunnel::example_multi_party_channel,
    ),
]
fun settle_link_rejects_non_conserving_split() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();
    example_multi_party_channel::register_participant(&mut network, @0xA, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);
    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_ab",
        @0xA,
        @0xB,
        50000,
        50000,
        &ctx,
    );

    // 60000 + 50000 = 110000, not the link's 100000 capacity sum.
    let _ = example_multi_party_channel::settle_link(&mut network, 0, 60000, 50000, &ctx);

    // Unreachable; present so the test type-checks.
    example_multi_party_channel::destroy_network_for_testing(network);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_multi_party_channel::EBalanceSumMismatch,
        location = sui_tunnel::example_multi_party_channel,
    ),
]
fun resolve_link_dispute_rejects_non_conserving_split() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let mut network = example_multi_party_channel::create_network(&clock, &mut ctx);
    let fee_policy = hop::default_fee_policy();
    example_multi_party_channel::register_participant(&mut network, @0xA, fee_policy, &ctx);
    example_multi_party_channel::register_participant(&mut network, @0xB, fee_policy, &ctx);
    example_multi_party_channel::add_link(
        &mut network,
        b"tunnel_ab",
        @0xA,
        @0xB,
        40000,
        40000,
        &ctx,
    );
    example_multi_party_channel::mark_link_disputed(&mut network, 0, &ctx);

    // 20000 + 20000 = 40000, not the link's 80000 capacity sum.
    let _ = example_multi_party_channel::resolve_link_dispute(&mut network, 0, 20000, 20000, &ctx);

    // Unreachable; present so the test type-checks.
    example_multi_party_channel::destroy_network_for_testing(network);
    clock::destroy_for_testing(clock);
}
