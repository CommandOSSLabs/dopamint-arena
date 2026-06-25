#[test_only]
module sui_tunnel::hop_tests;

use std::unit_test::assert_eq;
use sui_tunnel::hop;

#[test]
fun htlc_status_constants() {
    assert_eq!(hop::htlc_status_pending(), 0);
    assert_eq!(hop::htlc_status_claimed(), 1);
    assert_eq!(hop::htlc_status_expired(), 2);
    assert_eq!(hop::htlc_status_cancelled(), 3);
}

#[test]
fun route_status_constants() {
    assert_eq!(hop::route_status_planning(), 0);
    assert_eq!(hop::route_status_active(), 1);
    assert_eq!(hop::route_status_completed(), 2);
    assert_eq!(hop::route_status_failed(), 3);
}

#[test]
fun create_hop() {
    let hop = hop::create_hop(
        b"tunnel_1",
        @0x1234,
        1000,
        3600000,
        0,
    );

    assert_eq!(*hop::hop_tunnel_id(&hop), b"tunnel_1");
    assert_eq!(hop::hop_node_address(&hop), @0x1234);
    assert_eq!(hop::hop_fee(&hop), 1000);
    assert_eq!(hop::hop_timeout_ms(&hop), 3600000);
    assert_eq!(hop::hop_index(&hop), 0);
}

#[test]
fun create_route() {
    let route = hop::create_route(@0xA, @0xB, 10000, 1234567890);

    assert_eq!(hop::route_sender(&route), @0xA);
    assert_eq!(hop::route_receiver(&route), @0xB);
    assert_eq!(hop::route_amount(&route), 10000);
    assert_eq!(hop::route_hop_count(&route), 0);
    assert_eq!(hop::route_status(&route), 0);
}

#[test]
fun add_hop_to_route() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1234567890);

    hop::add_hop(&mut route, b"tunnel_1", @0xC, 100, 3600000);
    hop::add_hop(&mut route, b"tunnel_2", @0xB, 50, 3540000);

    assert_eq!(hop::route_hop_count(&route), 2);
    assert_eq!(hop::route_total_fees(&route), 150);
}

#[test]
fun validate_route() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1234567890);

    // Add hops with decreasing timeouts
    hop::add_hop(&mut route, b"tunnel_1", @0xC, 100, 3600000);
    hop::add_hop(&mut route, b"tunnel_2", @0xB, 50, 3480000); // 2 min less

    let validation = hop::validate_route(&route);
    assert!(hop::validation_valid(&validation));
    assert_eq!(hop::validation_total_amount(&validation), 10150);
}

#[test]
fun validate_route_bad_timeout() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1234567890);

    // Add hops with non-decreasing timeouts (invalid)
    hop::add_hop(&mut route, b"tunnel_1", @0xC, 100, 3600000);
    hop::add_hop(&mut route, b"tunnel_2", @0xB, 50, 3600000); // Same timeout - invalid

    let validation = hop::validate_route(&route);
    assert!(!hop::validation_valid(&validation));
}

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::EInvalidHop, location = sui_tunnel::hop)]
fun add_hop_rejects_fee_meeting_or_exceeding_amount() {
    let mut route = hop::create_route(@0xA, @0xB, 10, 1234567890);

    // A single hop cannot charge a fee that meets or exceeds the routed amount.
    hop::add_hop(&mut route, b"tunnel_1", @0xB, 100, 3600000);
}

#[test]
fun validate_route_small_fee_still_valid() {
    let mut route = hop::create_route(@0xA, @0xB, 10, 1234567890);

    hop::add_hop(&mut route, b"tunnel_1", @0xC, 1, 3600000);
    hop::add_hop(&mut route, b"tunnel_2", @0xB, 1, 3480000);

    let validation = hop::validate_route(&route);
    assert!(hop::validation_valid(&validation));
    assert_eq!(hop::validation_total_amount(&validation), 12);
}

#[test]
fun validate_route_cumulative_fees_exceed_amount() {
    let mut route = hop::create_route(@0xA, @0xB, 10, 1234567890);

    // Each fee individually fits the route amount, but together they consume it.
    hop::add_hop(&mut route, b"tunnel_1", @0xC, 6, 3600000);
    hop::add_hop(&mut route, b"tunnel_2", @0xB, 6, 3480000);

    let validation = hop::validate_route(&route);
    assert!(!hop::validation_valid(&validation));
    assert_eq!(hop::validation_error_code(&validation), 800);
}

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::EInvalidHop, location = sui_tunnel::hop)]
fun add_hop_fee_exceeds_amount_aborts() {
    let mut route = hop::create_route(@0xA, @0xB, 10, 1234567890);
    // Fee of 100 cannot be charged on a 10-unit route.
    hop::add_hop(&mut route, b"tunnel_1", @0xB, 100, 3600000);
}

#[test]
fun create_htlc() {
    let preimage = b"secret_preimage";
    let payment_hash = hop::create_payment_hash(&preimage);

    let htlc = hop::create_htlc(
        payment_hash,
        5000,
        @0xA,
        @0xB,
        3600000,
    );

    assert_eq!(hop::htlc_amount(&htlc), 5000);
    assert_eq!(hop::htlc_sender(&htlc), @0xA);
    assert_eq!(hop::htlc_receiver(&htlc), @0xB);
    assert_eq!(hop::htlc_status(&htlc), 0);
}

#[test]
fun htlc_claim() {
    let ctx = sui::tx_context::dummy(); // sender is @0x0
    let preimage = b"secret_preimage";
    let payment_hash = hop::create_payment_hash(&preimage);

    // receiver @0x0 matches dummy ctx sender
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0xA, @0x0, 3600000);

    // Claim with correct preimage
    let result = hop::claim_htlc(&mut htlc, preimage, &ctx);
    assert!(result);
    assert_eq!(hop::htlc_status(&htlc), 1);
    assert_eq!(*hop::htlc_preimage(&htlc), preimage);
}

#[test]
fun htlc_claim_wrong_preimage() {
    let ctx = sui::tx_context::dummy(); // sender is @0x0
    let preimage = b"secret_preimage";
    let payment_hash = hop::create_payment_hash(&preimage);

    // receiver @0x0 matches dummy ctx sender
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0xA, @0x0, 3600000);

    // Try to claim with wrong preimage
    let result = hop::claim_htlc(&mut htlc, b"wrong_preimage", &ctx);
    assert!(!result);
    assert_eq!(hop::htlc_status(&htlc), 0);
}

#[test]
fun htlc_expire() {
    let ctx = sui::tx_context::dummy();
    // Use @0x0 as sender since dummy ctx returns sender @0x0
    let mut htlc = hop::create_htlc(b"hash", 5000, @0x0, @0xB, 3600000);

    let result1 = hop::expire_htlc(&mut htlc, 3599999, &ctx);
    assert!(!result1);
    assert_eq!(hop::htlc_status(&htlc), 0);

    // Expire after timeout
    let result2 = hop::expire_htlc(&mut htlc, 3600001, &ctx);
    assert!(result2);
    assert_eq!(hop::htlc_status(&htlc), 2);
}

#[test]
fun fee_policy() {
    let policy = hop::create_fee_policy(1000, 500, 100, 1000000, 60000);

    // Calculate fee for 100000
    let fee = hop::calculate_fee(&policy, 100000);
    // base_fee(1000) + proportional(100000 * 500 / 1000000 = 50) = 1050
    assert_eq!(fee, 1050);

    assert!(hop::is_amount_acceptable(&policy, 500));
    assert!(!hop::is_amount_acceptable(&policy, 50)); // Below min
    assert!(!hop::is_amount_acceptable(&policy, 2000000)); // Above max
}

#[test]
fun routing_node() {
    let ctx = sui::tx_context::dummy();
    let policy = hop::default_fee_policy();
    let mut node = hop::create_routing_node(@0x0, policy);

    hop::add_tunnel_to_node(&mut node, b"tunnel_1", &ctx);
    hop::add_tunnel_to_node(&mut node, b"tunnel_2", &ctx);
    assert_eq!(hop::node_tunnel_count(&node), 2);

    hop::record_successful_route(&mut node, 10000, &ctx);
    hop::record_successful_route(&mut node, 20000, &ctx);
    hop::record_failed_route(&mut node, &ctx);

    assert_eq!(hop::node_total_routed(&node), 30000);
    assert_eq!(hop::node_successful_routes(&node), 2);
    assert_eq!(hop::node_failed_routes(&node), 1);

    // Success rate: 2/3 = 66.67% = 6666
    let rate = hop::node_success_rate(&node);
    assert_eq!(rate, 6666);
}

#[test]
fun cascading_timeouts() {
    let timeouts = hop::create_cascading_timeouts(3600000, 3, 120000);

    assert_eq!(timeouts.length(), 3);
    assert_eq!(timeouts[0], 3600000);
    assert_eq!(timeouts[1], 3480000);
    assert_eq!(timeouts[2], 3360000);
}

#[test]
fun cascading_timeouts_boundary_ok() {
    // base == num_hops * delta exactly: the loop's final subtraction reaches 0 (no underflow).
    let timeouts = hop::create_cascading_timeouts(180000, 3, 60000);
    assert_eq!(timeouts.length(), 3);
    assert_eq!(timeouts[0], 180000);
    assert_eq!(timeouts[1], 120000);
    assert_eq!(timeouts[2], 60000);
}

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::EInvalidTimeout, location = sui_tunnel::hop)]
fun cascading_timeouts_underflow_is_guarded() {
    // base=120000 < num_hops*delta=180000: the old guard (>= (num_hops-1)*delta) let this
    // through and the loop underflowed u64 mid-iteration (raw arithmetic abort). It must now
    // be rejected up front with the centralized EInvalidTimeout.
    let _ = hop::create_cascading_timeouts(120000, 3, 60000);
}

#[test]
fun estimate_route_fee() {
    // 10000 amount, 3 hops, 1000 base fee, 100 ppm
    let fee = hop::estimate_route_fee(10000, 3, 1000, 100);
    // 3 * 1000 + (10000 * 100 * 3) / 1000000 = 3000 + 3 = 3003
    assert_eq!(fee, 3003);
}

#[test]
fun route_lifecycle() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1234567890);
    assert_eq!(hop::route_status(&route), 0);

    hop::add_hop(&mut route, b"tunnel_1", @0xB, 100, 3600000);

    hop::activate_route(&mut route);
    assert_eq!(hop::route_status(&route), 1);

    hop::complete_route(&mut route);
    assert_eq!(hop::route_status(&route), 2);
}

#[test]
fun htlc_claimability() {
    let htlc = hop::create_htlc(b"hash", 5000, @0xA, @0xB, 3600000);

    // Claimable before expiry
    assert!(hop::is_htlc_claimable(&htlc, 3599999));

    // Not claimable at/after expiry
    assert!(!hop::is_htlc_claimable(&htlc, 3600000));
    assert!(!hop::is_htlc_claimable(&htlc, 3600001));

    // Expired check
    assert!(!hop::is_htlc_expired(&htlc, 3599999));
    assert!(hop::is_htlc_expired(&htlc, 3600000));
}

#[test]
fun payment_hash() {
    let preimage1 = b"preimage_1";
    let preimage2 = b"preimage_1";
    let preimage3 = b"preimage_2";

    let hash1 = hop::create_payment_hash(&preimage1);
    let hash2 = hop::create_payment_hash(&preimage2);
    let hash3 = hop::create_payment_hash(&preimage3);

    // Same preimage produces same hash
    assert_eq!(hash1, hash2);

    // Different preimage produces different hash
    assert!(hash1 != hash3);

    // Hash is 32 bytes
    assert_eq!(hash1.length(), 32);
}
