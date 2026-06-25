#[test_only]
module sui_tunnel::tunnel_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::signature;
use sui_tunnel::tunnel;

// ============================================
// STATUS & VERSION CONSTANTS
// ============================================

#[test]
fun status_constants() {
    assert_eq!(tunnel::status_created(), 0);
    assert_eq!(tunnel::status_active(), 1);
    assert_eq!(tunnel::status_closed(), 2);
    assert_eq!(tunnel::status_disputed(), 3);
    assert_eq!(tunnel::status_destroyed(), 4);
}

#[test]
fun version() {
    assert_eq!(tunnel::current_version(), 1);
}

// ============================================
// SERIALIZATION TESTS
// ============================================

#[test]
fun serialize_settlement() {
    let data = tunnel::create_settlement_data_for_testing(
        object::id_from_address(@0x1234),
        1000,
        2000,
        42,
        1234567890,
    );

    let serialized = tunnel::serialize_settlement(&data);

    // Should start with domain prefix
    let prefix = b"sui_tunnel::settlement";
    let prefix_len = prefix.length();
    prefix_len.do!(|i| assert_eq!(serialized[i], prefix[i]));
}

#[test]
fun serialize_state_update() {
    let data = tunnel::create_state_update_data_for_testing(
        object::id_from_address(@0x5678),
        vector[1u8, 2, 3, 4],
        10,
        9876543210,
        500,
        500,
    );

    let serialized = tunnel::serialize_state_update(&data);

    // Should start with domain prefix
    let prefix = b"sui_tunnel::state_update";
    let prefix_len = prefix.length();
    prefix_len.do!(|i| assert_eq!(serialized[i], prefix[i]));
}

#[test]
fun serialize_htlc_lock() {
    let data = tunnel::create_htlc_lock_data_for_testing(
        object::id_from_address(@0x1234),
        x"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        1000,
        @0xAAAA,
        @0xBBBB,
        5000,
    );

    let serialized = tunnel::serialize_htlc_lock(&data);

    // Should start with domain prefix
    let prefix = b"sui_tunnel::htlc_lock";
    let prefix_len = prefix.length();
    prefix_len.do!(|i| assert_eq!(serialized[i], prefix[i]));

    // Should contain the full serialized data
    assert!(serialized.length() > prefix_len);
}

#[test]
fun serialize_htlc_lock_deterministic() {
    let data1 = tunnel::create_htlc_lock_data_for_testing(
        object::id_from_address(@0x1234),
        x"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        1000,
        @0xAAAA,
        @0xBBBB,
        5000,
    );
    let data2 = tunnel::create_htlc_lock_data_for_testing(
        object::id_from_address(@0x1234),
        x"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        1000,
        @0xAAAA,
        @0xBBBB,
        5000,
    );
    let data3 = tunnel::create_htlc_lock_data_for_testing(
        object::id_from_address(@0x1234),
        x"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        1000,
        @0xAAAA,
        @0xBBBB,
        5000,
    );

    let s1 = tunnel::serialize_htlc_lock(&data1);
    let s2 = tunnel::serialize_htlc_lock(&data2);
    let s3 = tunnel::serialize_htlc_lock(&data3);

    // Same input -> same output
    assert_eq!(s1, s2);
    // Different input -> different output
    assert!(s1 != s3);
}

// ============================================
// STATE HASH & ACCESSOR TESTS
// ============================================

#[test]
fun create_state_hash() {
    let data1 = b"hello world";
    let data2 = b"hello world";
    let data3 = b"different data";

    let hash1 = tunnel::create_state_hash(&data1);
    let hash2 = tunnel::create_state_hash(&data2);
    let hash3 = tunnel::create_state_hash(&data3);

    // Same input should produce same hash
    assert_eq!(hash1, hash2);

    // Different input should produce different hash
    assert!(hash1 != hash3);

    // Hash should be 32 bytes (blake2b256)
    assert_eq!(hash1.length(), 32);
}

#[test]
fun party_config_accessors() {
    let config = tunnel::create_party_config_for_testing(
        @0xABCD,
        vector[1u8, 2, 3],
        0,
    );

    assert_eq!(tunnel::party_address(&config), @0xABCD);
    assert_eq!(*tunnel::party_public_key(&config), vector[1u8, 2, 3]);
    assert_eq!(tunnel::party_signature_type(&config), 0);
}

#[test]
fun state_commitment_accessors() {
    let commitment = tunnel::create_state_commitment_for_testing(
        vector[1u8, 2, 3, 4],
        42,
        1234567890,
        500,
        500,
    );

    assert_eq!(*tunnel::state_hash(&commitment), vector[1u8, 2, 3, 4]);
    assert_eq!(tunnel::state_nonce(&commitment), 42);
    assert_eq!(tunnel::state_timestamp(&commitment), 1234567890);
}

// ============================================
// TIMEOUT TESTS
// ============================================

#[test]
fun timeout_value_after_creation() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    assert_eq!(tunnel::timeout_ms(&tunnel), 60000);

    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
}

// Regression: a zero timeout is rejected up front with the centralized EInvalidTimeout
// for every constructor, not just create_and_fund. The trailing teardown never runs (the
// call aborts) but is required because Tunnel and Clock have no `drop`.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidTimeout,
        location = sui_tunnel::tunnel,
    ),
]
fun create_rejects_zero_timeout() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        0, // zero timeout
        0,
        &clock,
        &mut ctx,
    );

    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidTimeout,
        location = sui_tunnel::tunnel,
    ),
]
fun create_and_share_rejects_zero_timeout() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    tunnel::create_and_share<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        0, // zero timeout
        0,
        &clock,
        &mut ctx,
    );

    clock.destroy_for_testing();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidState,
        location = sui_tunnel::tunnel,
    ),
]
fun extend_timeout_wrong_status() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let mut tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    // Tunnel is CREATED, extend_timeout requires ACTIVE or DISPUTED -> invalid_state(1)
    tunnel::extend_timeout(&mut tunnel, 30000, &clock, &ctx);

    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
}

// ============================================
// PENALTY AMOUNT TESTS
// ============================================

#[test]
fun penalty_amount_stored() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    // Create tunnel with non-zero penalty
    let tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        500,
        &clock,
        &mut ctx,
    );

    assert_eq!(tunnel::penalty_amount(&tunnel), 500);

    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
}

// ============================================
// REFEREE TESTS
// ============================================

#[test]
fun set_referee() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let mut tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    // Initially no referee
    assert!(!tunnel::has_referee(&tunnel));

    // Set referee (sender is @0x0 = party_a)
    tunnel::set_referee(&mut tunnel, @0xCCCC, &ctx);

    assert!(tunnel::has_referee(&tunnel));
    assert_eq!(tunnel::get_referee(&tunnel), @0xCCCC);

    // Clean up dynamic field before destroying
    tunnel::remove_referee_for_testing(&mut tunnel);
    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
}

#[test]
fun set_referee_update() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let mut tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    // Set referee
    tunnel::set_referee(&mut tunnel, @0xCCCC, &ctx);
    assert_eq!(tunnel::get_referee(&tunnel), @0xCCCC);

    // Update referee
    tunnel::set_referee(&mut tunnel, @0xDDDD, &ctx);
    assert_eq!(tunnel::get_referee(&tunnel), @0xDDDD);

    tunnel::remove_referee_for_testing(&mut tunnel);
    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::ENotAuthorized,
        location = sui_tunnel::tunnel,
    ),
]
fun set_referee_not_authorized() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    // Neither party is @0x0 (the dummy sender)
    let mut tunnel = tunnel::create<SUI>(
        @0xAAAA,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    // Sender is @0x0, not a party -> not_authorized(0)
    tunnel::set_referee(&mut tunnel, @0xCCCC, &ctx);

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::ENoActiveDispute,
        location = sui_tunnel::tunnel,
    ),
]
fun resolve_dispute_external_not_disputed() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let mut tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    // Set referee
    tunnel::set_referee(&mut tunnel, @0x0, &ctx);

    // Try to resolve when not disputed (still CREATED) -> no_active_dispute(503)
    tunnel::resolve_dispute_external(&mut tunnel, 0, 0, &clock, &mut ctx);

    abort
}

#[test]
fun referee_survives_deposit() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let mut tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    // Set referee while CREATED
    tunnel::set_referee(&mut tunnel, @0xCCCC, &ctx);
    assert!(tunnel::has_referee(&tunnel));

    // Deposit (tunnel still CREATED after single deposit)
    let coin_a = coin::mint_for_testing<SUI>(500, &mut ctx);
    tunnel::deposit_party_a(&mut tunnel, coin_a, &clock, &ctx);

    // Referee persists across state changes
    assert!(tunnel::has_referee(&tunnel));
    assert_eq!(tunnel::get_referee(&tunnel), @0xCCCC);

    tunnel::remove_referee_for_testing(&mut tunnel);
    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
}

/// A referee may not be installed once either party has committed funds, so a party
/// cannot swap in a referee after the counterparty has deposited.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidState,
        location = sui_tunnel::tunnel,
    ),
]
fun set_referee_after_deposit_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let mut tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    // Party A deposits, committing funds while still CREATED.
    let coin_a = coin::mint_for_testing<SUI>(500, &mut ctx);
    tunnel::deposit_party_a(&mut tunnel, coin_a, &clock, &ctx);

    // Now set_referee must abort: funds are already committed.
    tunnel::set_referee(&mut tunnel, @0xCCCC, &ctx);

    abort
}

// ============================================
// HTLC TESTS
// ============================================

#[test]
fun htlc_accessors_no_htlcs() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    // No HTLCs initially
    assert_eq!(tunnel::party_htlc_locked(&tunnel, @0x0), 0);
    assert_eq!(tunnel::party_htlc_locked(&tunnel, @0xBBBB), 0);
    assert_eq!(tunnel::party_htlc_count(&tunnel, @0x0), 0);
    assert_eq!(tunnel::party_htlc_count(&tunnel, @0xBBBB), 0);

    let ph = x"0000000000000000000000000000000000000000000000000000000000000001";
    assert!(!tunnel::has_htlc(&tunnel, ph));

    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidState,
        location = sui_tunnel::tunnel,
    ),
]
fun lock_htlc_wrong_status() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let mut tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    let payment_hash = x"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    // Tunnel is CREATED, lock_htlc requires ACTIVE -> invalid_state(1)
    tunnel::lock_htlc(
        &mut tunnel,
        payment_hash,
        100,
        @0xBBBB,
        2000,
        vector[],
        &clock,
        &ctx,
    );

    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = sui_tunnel::tunnel::ENotFound, location = sui_tunnel::tunnel)]
fun claim_htlc_not_found() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let mut tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    let payment_hash = x"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    // No HTLC exists -> not_found(4)
    tunnel::claim_htlc_in_tunnel(
        &mut tunnel,
        payment_hash,
        b"preimage",
        &clock,
        &mut ctx,
    );

    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = sui_tunnel::tunnel::ENotFound, location = sui_tunnel::tunnel)]
fun expire_htlc_not_found() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let mut tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    let payment_hash = x"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    // No HTLC exists -> not_found(4)
    tunnel::expire_htlc_in_tunnel(
        &mut tunnel,
        payment_hash,
        &clock,
        &mut ctx,
    );

    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
}

#[test]
fun force_close_no_htlcs_backward_compat() {
    // Verifies that force_close still works identically when there are no HTLCs.
    // This test documents the invariant: with no HTLCs, get_party_htlc_locked returns 0,
    // so the adjusted balance equals the state balance.
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    // With no HTLCs, locked amounts are zero
    assert_eq!(tunnel::party_htlc_locked(&tunnel, @0x0), 0);
    assert_eq!(tunnel::party_htlc_locked(&tunnel, @0xBBBB), 0);

    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
}

/// Monotonic dispute progress: re-disputing an un-advanced state aborts, so a
/// resolution that returns the tunnel to ACTIVE cannot be followed by a free re-dispute.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EStaleState,
        location = sui_tunnel::tunnel,
    ),
]
fun raise_dispute_current_state_twice_same_nonce_aborts() {
    let party_a = @0xAAAA;
    let party_b = @0xBBBB;
    let mut scenario = test_scenario::begin(party_a);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let mut tunnel = tunnel::create_active_for_testing<SUI>(
        party_a,
        party_b,
        1000,
        500,
        60000,
        0,
        &clock,
        scenario.ctx(),
    );

    // First dispute on the nonce-0 state succeeds and records the disputed nonce.
    tunnel::raise_dispute_current_state(&mut tunnel, &clock, scenario.ctx());

    // Simulate a resolution that returns to ACTIVE without advancing the nonce.
    tunnel::reactivate_for_testing(&mut tunnel);

    // Re-disputing the same un-advanced state must abort.
    tunnel::raise_dispute_current_state(&mut tunnel, &clock, scenario.ctx());

    abort
}

/// A validly co-signed higher-nonce state must NOT be rejected just because its
/// off-chain signing timestamp precedes the stored state.timestamp. Dispute paths
/// overwrite state.timestamp with the on-chain clock, so a wall-clock monotonicity
/// guard would permanently freeze the channel after a resolve; ordering is the
/// nonce's job. Here an earlier timestamp clears the [created_at, now] bounds and
/// the update advances to signature verification, which the dummy signatures fail.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidSignature,
        location = sui_tunnel::tunnel,
    ),
]
fun update_state_allows_signed_timestamp_below_stored_state() {
    let party_a = @0xAAAA;
    let party_b = @0xBBBB;
    let mut scenario = test_scenario::begin(party_a);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let mut tunnel = tunnel::create_active_for_testing<SUI>(
        party_a,
        party_b,
        1000,
        500,
        60000,
        0,
        &clock,
        scenario.ctx(),
    );

    // Mimic a post-dispute tunnel: state.timestamp holds a large on-chain time.
    tunnel::set_state_timestamp_for_testing(&mut tunnel, 5000);
    clock.set_for_testing(6000);

    // timestamp 3000 precedes state.timestamp (5000) but is within [created_at, now]
    // and the nonce advances, so the update is not rejected on the timestamp and
    // proceeds to signature verification. The signatures are the correct 64-byte
    // length but cryptographically invalid, so verify returns false and tunnel's
    // own gate aborts (a wrong-length sig would trip the guard inside signature).
    let state_hash = x"00000000000000000000000000000000000000000000000000000000000000aa";
    let bad_sig =
        x"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    tunnel::update_state(
        &mut tunnel,
        state_hash,
        1,
        1000,
        500,
        3000,
        bad_sig,
        bad_sig,
        &clock,
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidNonce,
        location = sui_tunnel::tunnel,
    ),
]
fun update_state_rejects_reserved_max_nonce() {
    let party_a = @0xAAAA;
    let party_b = @0xBBBB;
    let mut scenario = test_scenario::begin(party_a);
    let clock = clock::create_for_testing(scenario.ctx());

    let mut tunnel = tunnel::create_active_for_testing<SUI>(
        party_a,
        party_b,
        1000,
        500,
        60000,
        0,
        &clock,
        scenario.ctx(),
    );

    // u64::MAX is reserved so that `state.nonce + 1` (settlement final_nonce and the
    // dispute high-water mark) can never overflow and trap funds. The guard runs
    // before signature verification, so dummy signatures are fine here.
    let state_hash = x"00000000000000000000000000000000000000000000000000000000000000aa";
    tunnel::update_state(
        &mut tunnel,
        state_hash,
        18446744073709551615,
        1000,
        500,
        0,
        b"sig_a",
        b"sig_b",
        &clock,
    );

    abort
}

// ============================================
// HTLC + DISPUTE-CLOSE ACCOUNTING REGRESSIONS
// ============================================
// With an outstanding HTLC the disputed state's balances are already net of
// the locked amount (lock_htlc debits them and splits the funds into a separate
// dynamic field). The three settlement paths must therefore distribute the full
// remaining `tunnel.balance` directly — NOT re-subtract the locked amount, which
// previously underflowed u64 or tripped the balance-sum assertion and trapped
// funds. These tests lock a real HTLC and drive each close path to completion.

const HTLC_HASH: vector<u8> = x"00000000000000000000000000000000000000000000000000000000000000aa";

#[test]
fun htlc_force_close_distributes_full_remaining_balance() {
    let party_a = @0xAAAA;
    let party_b = @0xBBBB;
    let mut scenario = test_scenario::begin(party_a);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    // deposits a=1000, b=500 -> combined balance 1500
    let mut tunnel = tunnel::create_active_for_testing<SUI>(
        party_a,
        party_b,
        1000,
        500,
        60000,
        0,
        &clock,
        scenario.ctx(),
    );

    // party_a locks a 200-unit HTLC -> balance 1300, state.a 800, state.b 500
    tunnel::lock_htlc_no_sig_for_testing(
        &mut tunnel,
        HTLC_HASH,
        200,
        @0xDDDD,
        5000,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(tunnel::party_htlc_locked(&tunnel, party_a), 200);

    // party_a disputes the current state and waits out the timeout
    tunnel::raise_dispute_current_state(&mut tunnel, &clock, scenario.ctx());
    clock.set_for_testing(1000 + 60000 + 1);
    tunnel::force_close_after_timeout(&mut tunnel, &clock, scenario.ctx());
    assert_eq!(tunnel::status(&tunnel), tunnel::status_closed());

    // Both parties received their full net balances (800 / 500).
    scenario.next_tx(party_a);
    let coin_a = scenario.take_from_address<coin::Coin<SUI>>(party_a);
    let coin_b = scenario.take_from_address<coin::Coin<SUI>>(party_b);
    assert_eq!(coin_a.value(), 800);
    assert_eq!(coin_b.value(), 500);
    coin_a.burn_for_testing();
    coin_b.burn_for_testing();

    // The locked 200 remained separate and is still expirable by its sender
    // (its 5000ms expiry has long passed by the dispute-timeout point).
    tunnel::expire_htlc_in_tunnel(&mut tunnel, HTLC_HASH, &clock, scenario.ctx());
    assert_eq!(tunnel::party_htlc_locked(&tunnel, party_a), 0);

    tunnel::remove_htlc_counters_for_testing(&mut tunnel);
    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun htlc_agree_to_dispute_distributes_full_remaining_balance() {
    let party_a = @0xAAAA;
    let party_b = @0xBBBB;
    let mut scenario = test_scenario::begin(party_a);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let mut tunnel = tunnel::create_active_for_testing<SUI>(
        party_a,
        party_b,
        1000,
        500,
        60000,
        0,
        &clock,
        scenario.ctx(),
    );

    tunnel::lock_htlc_no_sig_for_testing(
        &mut tunnel,
        HTLC_HASH,
        200,
        @0xDDDD,
        5000,
        &clock,
        scenario.ctx(),
    );
    tunnel::raise_dispute_current_state(&mut tunnel, &clock, scenario.ctx());

    // The non-raiser (party_b) agrees, closing immediately without a timeout.
    scenario.next_tx(party_b);
    tunnel::agree_to_dispute(&mut tunnel, &clock, scenario.ctx());
    assert_eq!(tunnel::status(&tunnel), tunnel::status_closed());

    scenario.next_tx(party_a);
    let coin_a = scenario.take_from_address<coin::Coin<SUI>>(party_a);
    let coin_b = scenario.take_from_address<coin::Coin<SUI>>(party_b);
    assert_eq!(coin_a.value(), 800);
    assert_eq!(coin_b.value(), 500);
    coin_a.burn_for_testing();
    coin_b.burn_for_testing();

    tunnel::remove_htlc_counters_for_testing(&mut tunnel);
    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun htlc_resolve_dispute_external_distributes_full_remaining_balance() {
    let party_a = @0xAAAA;
    let party_b = @0xBBBB;
    let referee = @0xCCCC;
    let mut scenario = test_scenario::begin(party_a);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let mut tunnel = tunnel::create_active_for_testing<SUI>(
        party_a,
        party_b,
        1000,
        500,
        60000,
        0,
        &clock,
        scenario.ctx(),
    );
    tunnel::set_referee_for_testing(&mut tunnel, referee);

    tunnel::lock_htlc_no_sig_for_testing(
        &mut tunnel,
        HTLC_HASH,
        200,
        @0xDDDD,
        5000,
        &clock,
        scenario.ctx(),
    );
    tunnel::raise_dispute_current_state(&mut tunnel, &clock, scenario.ctx());

    // The referee resolves, distributing the full remaining balance (1300).
    scenario.next_tx(referee);
    tunnel::resolve_dispute_external(&mut tunnel, 900, 400, &clock, scenario.ctx());
    assert_eq!(tunnel::status(&tunnel), tunnel::status_closed());

    scenario.next_tx(party_a);
    let coin_a = scenario.take_from_address<coin::Coin<SUI>>(party_a);
    let coin_b = scenario.take_from_address<coin::Coin<SUI>>(party_b);
    assert_eq!(coin_a.value(), 900);
    assert_eq!(coin_b.value(), 400);
    coin_a.burn_for_testing();
    coin_b.burn_for_testing();

    tunnel::remove_referee_for_testing(&mut tunnel);
    tunnel::remove_htlc_counters_for_testing(&mut tunnel);
    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
    scenario.end();
}

/// Destroying a closed tunnel that still has an outstanding HTLC must abort:
/// HTLC funds would otherwise be stranded (claim/expire refuse a DESTROYED tunnel).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EOutstandingHtlc,
        location = sui_tunnel::tunnel,
    ),
]
fun destroy_tunnel_with_outstanding_htlc_aborts() {
    let party_a = @0xAAAA;
    let party_b = @0xBBBB;
    let mut scenario = test_scenario::begin(party_a);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let mut tunnel = tunnel::create_active_for_testing<SUI>(
        party_a,
        party_b,
        1000,
        500,
        60000,
        0,
        &clock,
        scenario.ctx(),
    );

    tunnel::lock_htlc_no_sig_for_testing(
        &mut tunnel,
        HTLC_HASH,
        200,
        @0xDDDD,
        5000,
        &clock,
        scenario.ctx(),
    );
    tunnel::raise_dispute_current_state(&mut tunnel, &clock, scenario.ctx());
    clock.set_for_testing(1000 + 60000 + 1);
    tunnel::force_close_after_timeout(&mut tunnel, &clock, scenario.ctx());
    assert_eq!(tunnel::status(&tunnel), tunnel::status_closed());

    // Balance is 0 and CLOSED, but the 200-unit HTLC is still locked -> abort.
    tunnel::destroy_tunnel(&mut tunnel, &clock, scenario.ctx());

    tunnel::remove_htlc_counters_for_testing(&mut tunnel);
    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
    scenario.end();
}

/// Once the outstanding HTLC is expired (or claimed), destroy_tunnel succeeds.
#[test]
fun destroy_tunnel_after_htlc_resolved() {
    let party_a = @0xAAAA;
    let party_b = @0xBBBB;
    let mut scenario = test_scenario::begin(party_a);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let mut tunnel = tunnel::create_active_for_testing<SUI>(
        party_a,
        party_b,
        1000,
        500,
        60000,
        0,
        &clock,
        scenario.ctx(),
    );

    tunnel::lock_htlc_no_sig_for_testing(
        &mut tunnel,
        HTLC_HASH,
        200,
        @0xDDDD,
        5000,
        &clock,
        scenario.ctx(),
    );
    tunnel::raise_dispute_current_state(&mut tunnel, &clock, scenario.ctx());
    clock.set_for_testing(1000 + 60000 + 1);
    tunnel::force_close_after_timeout(&mut tunnel, &clock, scenario.ctx());

    // Reclaim the expired HTLC, clearing the outstanding-lock counter.
    tunnel::expire_htlc_in_tunnel(&mut tunnel, HTLC_HASH, &clock, scenario.ctx());
    assert_eq!(tunnel::party_htlc_locked(&tunnel, party_a), 0);

    tunnel::destroy_tunnel(&mut tunnel, &clock, scenario.ctx());
    assert_eq!(tunnel::status(&tunnel), tunnel::status_destroyed());

    tunnel::remove_htlc_counters_for_testing(&mut tunnel);
    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
    scenario.end();
}

// ============================================
// CLOSE COOPERATIVE TESTS
// ============================================

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidSignature,
        location = sui_tunnel::tunnel,
    ),
]
fun close_cooperative_requires_signatures() {
    // Verifies that close_cooperative no longer accepts empty signatures.
    // Use withdraw_before_active for unilateral withdrawal instead.
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";

    let mut tunnel = tunnel::create<SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        60000,
        0,
        &clock,
        &mut ctx,
    );

    // Try close_cooperative with empty sigs -> invalid_signature(100)
    tunnel::close_cooperative(
        &mut tunnel,
        0,
        0,
        vector[],
        vector[],
        1000,
        &clock,
        &mut ctx,
    );

    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
}
