#[test_only]
module sui_tunnel::hop_tests;

use std::unit_test::{assert_eq, destroy};
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

    assert_eq!(*hop.hop_tunnel_id(), b"tunnel_1");
    assert_eq!(hop.hop_node_address(), @0x1234);
    assert_eq!(hop.hop_fee(), 1000);
    assert_eq!(hop.hop_timeout_ms(), 3600000);
    assert_eq!(hop.hop_index(), 0);
}

#[test]
fun create_route() {
    let route = hop::create_route(@0xA, @0xB, 10000, 1234567890);

    assert_eq!(route.route_sender(), @0xA);
    assert_eq!(route.route_receiver(), @0xB);
    assert_eq!(route.route_amount(), 10000);
    assert_eq!(route.route_hop_count(), 0);
    assert_eq!(route.route_status(), 0);
}

#[test]
fun add_hop_to_route() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1234567890);

    route.add_hop(b"tunnel_1", @0xC, 100, 3600000);
    route.add_hop(b"tunnel_2", @0xB, 50, 3540000);

    assert_eq!(route.route_hop_count(), 2);
    assert_eq!(route.route_total_fees(), 150);
}

#[test]
fun validate_route() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1234567890);

    // Add hops with decreasing timeouts
    route.add_hop(b"tunnel_1", @0xC, 100, 3600000);
    route.add_hop(b"tunnel_2", @0xB, 50, 3480000); // 2 min less

    let validation = route.validate_route();
    assert!(validation.validation_valid());
    assert_eq!(validation.validation_total_amount(), 10150);
}

#[test]
fun validate_route_bad_timeout() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1234567890);

    // Add hops with non-decreasing timeouts (invalid)
    route.add_hop(b"tunnel_1", @0xC, 100, 3600000);
    route.add_hop(b"tunnel_2", @0xB, 50, 3600000); // Same timeout - invalid

    let validation = route.validate_route();
    assert!(!validation.validation_valid());
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

    assert_eq!(htlc.htlc_amount(), 5000);
    assert_eq!(htlc.htlc_sender(), @0xA);
    assert_eq!(htlc.htlc_receiver(), @0xB);
    assert_eq!(htlc.htlc_status(), 0);
}

#[test]
fun htlc_claim() {
    let ctx = sui::tx_context::dummy(); // sender is @0x0
    let preimage = b"secret_preimage";
    let payment_hash = hop::create_payment_hash(&preimage);

    // receiver @0x0 matches dummy ctx sender
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0xA, @0x0, 3600000);

    // Claim with correct preimage
    let result = htlc.claim_htlc(preimage, &ctx);
    assert!(result);
    assert_eq!(htlc.htlc_status(), 1);
    assert_eq!(*htlc.htlc_preimage(), preimage);
}

#[test]
fun htlc_claim_wrong_preimage() {
    let ctx = sui::tx_context::dummy(); // sender is @0x0
    let preimage = b"secret_preimage";
    let payment_hash = hop::create_payment_hash(&preimage);

    // receiver @0x0 matches dummy ctx sender
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0xA, @0x0, 3600000);

    // Try to claim with wrong preimage
    let result = htlc.claim_htlc(b"wrong_preimage", &ctx);
    assert!(!result);
    assert_eq!(htlc.htlc_status(), 0);
}

#[test]
fun htlc_expire() {
    let ctx = sui::tx_context::dummy();
    // payment_hash must be exactly 32 bytes; expire does not verify a preimage so any
    // 32-byte hash works here.
    let payment_hash = hop::create_payment_hash(&b"any_preimage");
    // Use @0x0 as sender since dummy ctx returns sender @0x0
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0x0, @0xB, 3600000);

    let result1 = htlc.expire_htlc(3599999, &ctx);
    assert!(!result1);
    assert_eq!(htlc.htlc_status(), 0);

    // Expire after timeout
    let result2 = htlc.expire_htlc(3600001, &ctx);
    assert!(result2);
    assert_eq!(htlc.htlc_status(), 2);
}

#[test]
fun fee_policy() {
    let policy = hop::create_fee_policy(1000, 500, 100, 1000000, 60000);

    // Calculate fee for 100000
    let fee = policy.calculate_fee(100000);
    // base_fee(1000) + proportional(100000 * 500 / 1000000 = 50) = 1050
    assert_eq!(fee, 1050);

    assert!(policy.is_amount_acceptable(500));
    assert!(!policy.is_amount_acceptable(50)); // Below min
    assert!(!policy.is_amount_acceptable(2000000)); // Above max
}

#[test]
fun routing_node() {
    let ctx = sui::tx_context::dummy();
    let policy = hop::default_fee_policy();
    let mut node = hop::create_routing_node(@0x0, policy);

    node.add_tunnel_to_node(b"tunnel_1", &ctx);
    node.add_tunnel_to_node(b"tunnel_2", &ctx);
    assert_eq!(node.node_tunnel_count(), 2);

    node.record_successful_route(10000, &ctx);
    node.record_successful_route(20000, &ctx);
    node.record_failed_route(&ctx);

    assert_eq!(node.node_total_routed(), 30000);
    assert_eq!(node.node_successful_routes(), 2);
    assert_eq!(node.node_failed_routes(), 1);

    // Success rate: 2/3 = 66.67% = 6666
    let rate = node.node_success_rate();
    assert_eq!(rate, 6666);
}

#[test]
fun cascading_timeouts() {
    let timeouts = hop::create_cascading_timeouts(3600000, 3, 120000);

    assert_eq!(timeouts.length(), 3);
    assert_eq!(*timeouts.borrow(0), 3600000);
    assert_eq!(*timeouts.borrow(1), 3480000);
    assert_eq!(*timeouts.borrow(2), 3360000);
}

#[test]
fun cascading_timeouts_boundary_ok() {
    // base == num_hops * delta exactly: the loop's final subtraction reaches 0 (no underflow).
    let timeouts = hop::create_cascading_timeouts(180000, 3, 60000);
    assert_eq!(timeouts.length(), 3);
    assert_eq!(*timeouts.borrow(0), 180000);
    assert_eq!(*timeouts.borrow(1), 120000);
    assert_eq!(*timeouts.borrow(2), 60000);
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
    assert_eq!(route.route_status(), 0);

    route.add_hop(b"tunnel_1", @0xB, 100, 3600000);

    route.activate_route();
    assert_eq!(route.route_status(), 1);

    route.complete_route();
    assert_eq!(route.route_status(), 2);
}

#[test]
fun htlc_claimability() {
    // payment_hash must be exactly 32 bytes.
    let payment_hash = hop::create_payment_hash(&b"any_preimage");
    let htlc = hop::create_htlc(payment_hash, 5000, @0xA, @0xB, 3600000);

    // Claimable before expiry
    assert!(htlc.is_htlc_claimable(3599999));

    // Not claimable at/after expiry
    assert!(!htlc.is_htlc_claimable(3600000));
    assert!(!htlc.is_htlc_claimable(3600001));

    // Expired check
    assert!(!htlc.is_htlc_expired(3599999));
    assert!(htlc.is_htlc_expired(3600000));
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

// ============================================
// add_hop failure paths
// ============================================

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::EMaxHopsExceeded, location = sui_tunnel::hop)]
fun add_hop_exceeding_max_hops_aborts() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1234567890);

    // Push exactly MAX_HOPS hops (the limit), then one more must abort.
    let max = hop::max_hops();
    let mut i = 0;
    while (i < max) {
        route.add_hop(b"tunnel", @0xC, 1, 3600000);
        i = i + 1;
    };
    // The (max + 1)th hop exceeds the cap.
    route.add_hop(b"tunnel", @0xC, 1, 3600000);
}

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::EInvalidHop, location = sui_tunnel::hop)]
fun add_hop_on_non_planning_route_aborts() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1234567890);
    route.add_hop(b"tunnel_1", @0xB, 100, 3600000);
    route.activate_route(); // route now ACTIVE, no longer PLANNING

    // add_hop requires ROUTE_STATUS_PLANNING.
    route.add_hop(b"tunnel_2", @0xC, 50, 3540000);
}

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::EOverflow, location = sui_tunnel::hop)]
fun add_hop_fee_accumulation_overflow_aborts() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1234567890);

    // First hop carries the full u64::MAX fee; the second hop's fee makes the
    // accumulated total overflow u64, which the u128 guard rejects with EOverflow.
    route.add_hop(b"tunnel_1", @0xC, 18446744073709551615, 3600000);
    route.add_hop(b"tunnel_2", @0xC, 1, 3540000);
}

// ============================================
// create_fee_policy invariants
// ============================================

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::EInvalidParameter, location = sui_tunnel::hop)]
fun create_fee_policy_min_above_max_aborts() {
    // min_htlc > max_htlc violates the invariant.
    let _ = hop::create_fee_policy(1000, 500, 2000, 1000, 60000);
}

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::EInvalidTimeout, location = sui_tunnel::hop)]
fun create_fee_policy_sub_minimum_timeout_delta_aborts() {
    // min_timeout_delta_ms below MIN_TIMEOUT_DELTA_MS (60000) is rejected.
    let _ = hop::create_fee_policy(1000, 500, 100, 1000000, 59999);
}

#[test]
fun create_fee_policy_at_minimum_timeout_delta_ok() {
    // Exactly at the minimum delta is accepted (boundary).
    let policy = hop::create_fee_policy(1000, 500, 100, 1000000, hop::min_timeout_delta_ms());
    assert_eq!(policy.policy_min_timeout_delta_ms(), 60000);
    assert_eq!(policy.policy_min_htlc(), 100);
    assert_eq!(policy.policy_max_htlc(), 1000000);
}

// ============================================
// create_htlc payment_hash length check
// ============================================

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::EInvalidParameter, location = sui_tunnel::hop)]
fun create_htlc_non_32_byte_hash_aborts() {
    // A payment_hash that is not exactly 32 bytes is rejected.
    let _ = hop::create_htlc(b"too_short", 5000, @0xA, @0xB, 3600000);
}

#[test]
fun create_htlc_32_byte_hash_ok() {
    // A 32-byte payment_hash is accepted.
    let payment_hash = hop::create_payment_hash(&b"preimage");
    assert_eq!(payment_hash.length(), 32);

    let htlc = hop::create_htlc(payment_hash, 5000, @0xA, @0xB, 3600000);
    assert_eq!(htlc.htlc_amount(), 5000);
    assert_eq!(*htlc.htlc_payment_hash(), payment_hash);
}

// ============================================
// remove_tunnel_from_node behavior
// ============================================

#[test]
fun remove_tunnel_from_node_present_ok() {
    let ctx = sui::tx_context::dummy(); // sender @0x0
    let mut node = node_with_address(@0x0);

    node.add_tunnel_to_node(b"tunnel_1", &ctx);
    node.add_tunnel_to_node(b"tunnel_2", &ctx);
    assert_eq!(node.node_tunnel_count(), 2);

    node.remove_tunnel_from_node(&b"tunnel_1", &ctx);
    assert_eq!(node.node_tunnel_count(), 1);

    destroy(node);
}

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::ENotFound, location = sui_tunnel::hop)]
fun remove_tunnel_from_node_absent_aborts() {
    let ctx = sui::tx_context::dummy(); // sender @0x0
    let mut node = node_with_address(@0x0);

    node.add_tunnel_to_node(b"tunnel_1", &ctx);

    // Removing an id that was never added now aborts ENotFound (previously a no-op).
    node.remove_tunnel_from_node(&b"missing", &ctx);
}

// ============================================
// EOverflow guards on fee math
// ============================================

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::EOverflow, location = sui_tunnel::hop)]
fun calculate_fee_overflow_aborts() {
    // proportional term (amount * rate / 1e6) + base_fee overflows u64.
    // amount = u64::MAX, rate_ppm = 1_000_000 -> proportional == u64::MAX,
    // plus base_fee 1 overflows.
    let policy = hop::create_fee_policy(1, 1_000_000, 1, 18446744073709551615, 60000);
    let _ = policy.calculate_fee(18446744073709551615);
}

#[test]
fun calculate_fee_normal_math_ok() {
    // base_fee(1000) + proportional(100000 * 500 / 1_000_000 = 50) = 1050.
    let policy = hop::create_fee_policy(1000, 500, 100, 1000000, 60000);
    let fee = policy.calculate_fee(100000);
    assert_eq!(fee, 1050);
}

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::EOverflow, location = sui_tunnel::hop)]
fun calculate_total_with_fees_overflow_aborts() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1234567890);
    // Give the route a fee equal to u64::MAX so any positive amount overflows the sum.
    route.add_hop(b"tunnel_1", @0xB, 18446744073709551615, 3600000);

    let _ = hop::calculate_total_with_fees(1, &route);
}

#[test]
fun calculate_total_with_fees_normal_ok() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1234567890);
    route.add_hop(b"tunnel_1", @0xC, 100, 3600000);
    route.add_hop(b"tunnel_2", @0xB, 50, 3540000);

    // amount(10000) + total_fees(150) = 10150.
    assert_eq!(hop::calculate_total_with_fees(10000, &route), 10150);
}

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::EOverflow, location = sui_tunnel::hop)]
fun estimate_route_fee_overflow_aborts() {
    // total_base = avg_base_fee * hop_count overflows u64.
    let _ = hop::estimate_route_fee(0, 2, 18446744073709551615, 0);
}

#[test]
fun estimate_route_fee_normal_ok() {
    // 3 * 1000 + (10000 * 100 * 3) / 1_000_000 = 3000 + 3 = 3003.
    let fee = hop::estimate_route_fee(10000, 3, 1000, 100);
    assert_eq!(fee, 3003);
}

// ============================================
// HTLC cancel + unauthorized-action guards
// ============================================

#[test]
fun cancel_htlc_transitions_to_cancelled() {
    let ctx = sui::tx_context::dummy(); // sender @0x0 (the sender of the HTLC)
    let payment_hash = hop::create_payment_hash(&b"cancel_preimage");
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0x0, @0xB, 3600000);

    // A pending HTLC is cancelled by its sender; emits HTLCCancelled.
    let result = htlc.cancel_htlc(&ctx);
    assert!(result);
    assert_eq!(htlc.htlc_status(), hop::htlc_status_cancelled());

    // Cancelling again is a no-op (not pending) and returns false.
    let result2 = htlc.cancel_htlc(&ctx);
    assert!(!result2);

    destroy(htlc);
}

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::ENotAuthorized, location = sui_tunnel::hop)]
fun claim_htlc_wrong_sender_aborts() {
    let ctx = sui::tx_context::dummy(); // sender @0x0, but receiver is @0xB
    let preimage = b"secret_preimage";
    let payment_hash = hop::create_payment_hash(&preimage);
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0xA, @0xB, 3600000);

    // Only the receiver (@0xB) may claim; @0x0 is unauthorized.
    let _ = htlc.claim_htlc(preimage, &ctx);
}

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::ENotAuthorized, location = sui_tunnel::hop)]
fun expire_htlc_wrong_sender_aborts() {
    let ctx = sui::tx_context::dummy(); // sender @0x0, but HTLC sender is @0xA
    let payment_hash = hop::create_payment_hash(&b"expire_preimage");
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0xA, @0xB, 3600000);

    // Only the HTLC sender (@0xA) may expire/reclaim; @0x0 is unauthorized.
    let _ = htlc.expire_htlc(3600001, &ctx);
}

#[test]
#[expected_failure(abort_code = sui_tunnel::hop::ENotAuthorized, location = sui_tunnel::hop)]
fun cancel_htlc_unauthorized_party_aborts() {
    let ctx = sui::tx_context::dummy(); // sender @0x0, neither HTLC sender nor receiver
    let payment_hash = hop::create_payment_hash(&b"cancel_preimage");
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0xA, @0xB, 3600000);

    // Only the HTLC sender (@0xA) or receiver (@0xB) may cancel; @0x0 is unauthorized.
    let _ = htlc.cancel_htlc(&ctx);
}

// ============================================
// Test helpers
// ============================================

fun node_with_address(addr: address): hop::RoutingNode {
    hop::create_routing_node(addr, hop::default_fee_policy())
}
