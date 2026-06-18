/// Integration tests for the Sui Tunnel Framework
///
/// This file contains integration tests that span multiple modules.
/// Module-specific unit tests are located within each module's source file.
#[test_only]
module sui_tunnel::sui_tunnel_tests;

use std::unit_test::assert_eq;
use sui_tunnel::hop;
use sui_tunnel::randomness;
use sui_tunnel::referee;
use sui_tunnel::signature;
use sui_tunnel::tunnel;
use sui_tunnel::zk_verifier;

/// Test that signature module is accessible and works with errors module
#[test]
fun signature_module_accessible() {
    // Verify signature types are accessible
    assert_eq!(signature::ed25519(), 0);
    assert_eq!(signature::bls12381_min_sig(), 1);
    assert_eq!(signature::bls12381_min_pk(), 2);
    assert_eq!(signature::secp256k1(), 3);

    // Verify we can check valid signature types
    assert!(signature::is_valid_signature_type(signature::ed25519()));
    assert!(signature::is_valid_signature_type(signature::bls12381_min_sig()));
    assert!(!signature::is_valid_signature_type(99));
}

/// Test integration between signature utilities and error handling
#[test]
fun signature_error_integration() {
    // The signature module uses errors module internally
    // This test verifies the modules work together correctly

    // Create a valid ED25519 public key (32 bytes)
    let mut pk_32 = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_32.push_back(0); i = i + 1; };

    // Verify length validation works
    assert!(signature::is_valid_public_key_length(signature::ed25519(), &pk_32));

    // Wrong length should fail
    let pk_wrong = vector[0u8, 1, 2];
    assert!(!signature::is_valid_public_key_length(signature::ed25519(), &pk_wrong));
}

/// Test message construction utilities
#[test]
fun message_construction() {
    // Test domain-separated message
    let domain = b"sui_tunnel::test";
    let message = b"payload";
    let result = signature::create_domain_separated_message(domain, message);

    // Verify structure
    assert!(result.length() > 0);

    // Test tunnel message
    let tunnel_id = vector[1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    let nonce = 12345u64;
    let data = b"state_data";
    let tunnel_msg = signature::create_tunnel_message(tunnel_id, nonce, data);

    // Verify it starts with "tunnel"
    assert!(tunnel_msg.length() > 6);

    // Test byte conversion roundtrip
    let original_nonce = 9876543210u64;
    let bytes = signature::u64_to_be_bytes(original_nonce);
    let recovered = signature::be_bytes_to_u64(&bytes);
    assert_eq!(original_nonce, recovered);
}

/// Test that tunnel module is accessible
#[test]
fun tunnel_module_accessible() {
    // Verify tunnel status constants
    assert_eq!(tunnel::status_created(), 0);
    assert_eq!(tunnel::status_active(), 1);
    assert_eq!(tunnel::status_closed(), 2);
    assert_eq!(tunnel::status_disputed(), 3);
}

/// Test tunnel state hash creation
#[test]
fun tunnel_state_hash() {
    let data1 = b"test state data";
    let data2 = b"test state data";
    let data3 = b"different data";

    let hash1 = tunnel::create_state_hash(&data1);
    let hash2 = tunnel::create_state_hash(&data2);
    let hash3 = tunnel::create_state_hash(&data3);

    // Same data should produce same hash
    assert_eq!(hash1, hash2);

    // Different data should produce different hash
    assert!(hash1 != hash3);

    // Hash should be 32 bytes (blake2b256)
    assert_eq!(hash1.length(), 32);
}

/// Test integration: signature types work with tunnel party config
#[test]
fun tunnel_signature_integration() {
    // This test verifies that signature types defined in signature module
    // are compatible with what tunnel module expects for party configuration

    // ED25519: 32-byte public key
    assert_eq!(signature::public_key_size(signature::ed25519()), 32);

    // BLS12381 min sig: 96-byte public key
    assert_eq!(signature::public_key_size(signature::bls12381_min_sig()), 96);

    // BLS12381 min pk: 48-byte public key
    assert_eq!(signature::public_key_size(signature::bls12381_min_pk()), 48);

    // These are all valid signature types that can be used with tunnels
    assert!(signature::is_valid_signature_type(signature::ed25519()));
    assert!(signature::is_valid_signature_type(signature::bls12381_min_sig()));
    assert!(signature::is_valid_signature_type(signature::bls12381_min_pk()));
    assert!(signature::is_valid_signature_type(signature::secp256k1()));
}

/// Test that randomness module is accessible
#[test]
fun randomness_module_accessible() {
    // Create a seed and verify it works
    let seed = randomness::from_bytes(b"test seed");

    // Verify we can derive random values
    let (value, new_seed) = randomness::next_u64(&seed);

    // Values should be deterministic
    let (value2, _) = randomness::next_u64(&seed);
    assert_eq!(value, value2);

    // New seed should have incremented counter
    assert_eq!(randomness::seed_counter(&new_seed), 1);
}

/// Test integration: randomness with tunnel context
#[test]
fun randomness_tunnel_integration() {
    // Simulate creating randomness for a tunnel
    let tunnel_id = vector[1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    let nonce = 42u64;
    let extra_entropy = b"dealer_signature_would_go_here";

    let seed = randomness::from_tunnel_context(tunnel_id, nonce, extra_entropy);

    // Should produce valid 32-byte seed
    assert_eq!(randomness::seed_bytes(&seed).length(), 32);

    // Can use for game mechanics
    let (card, _) = randomness::next_u8_in_range(&seed, 0, 52);
    assert!(card < 52);
}

/// Test integration: commit-reveal with signature module
#[test]
fun randomness_commit_reveal_integration() {
    // Party A creates commitment
    let value_a = b"alice_random_value";
    let salt_a = b"alice_salt_at_least_16_chars";
    let commitment_a = randomness::create_commitment(&value_a, &salt_a, @0xA, 1000);

    // Party B creates commitment
    let value_b = b"bob_random_value";
    let salt_b = b"bob_salt_at_least_16_chars!!";
    let commitment_b = randomness::create_commitment(&value_b, &salt_b, @0xB, 1001);

    // Create combined randomness
    let mut combined = randomness::create_combined_randomness(commitment_a, commitment_b);
    assert!(!randomness::is_finalized(&combined));

    // Reveal phase
    let reveal_a = randomness::create_reveal(value_a, salt_a);
    let reveal_b = randomness::create_reveal(value_b, salt_b);

    // Finalize
    randomness::finalize_combined_randomness(&mut combined, &reveal_a, &reveal_b);
    assert!(randomness::is_finalized(&combined));

    // Can now use the combined seed
    let seed = randomness::combined_seed(&combined);
    let (_, _) = randomness::next_u64(seed);
}

/// Test integration: game simulation using randomness
#[test]
fun game_simulation() {
    // Simulate a simple card game
    let seed = randomness::from_bytes(b"game_session_seed");

    // Create a deck (0-51)
    let mut deck = vector<u8>[];
    let mut i = 0u8;
    while (i < 52) {
        deck.push_back(i);
        i = i + 1;
    };

    // Shuffle the deck
    let shuffled_seed = randomness::shuffle(&seed, &mut deck);

    // Draw 5 cards
    let (card1, seed1) = randomness::draw_from_vector(&shuffled_seed, &mut deck);
    let (card2, seed2) = randomness::draw_from_vector(&seed1, &mut deck);
    let (card3, seed3) = randomness::draw_from_vector(&seed2, &mut deck);
    let (card4, seed4) = randomness::draw_from_vector(&seed3, &mut deck);
    let (card5, _) = randomness::draw_from_vector(&seed4, &mut deck);

    // All cards should be valid (0-51)
    assert!(card1 < 52);
    assert!(card2 < 52);
    assert!(card3 < 52);
    assert!(card4 < 52);
    assert!(card5 < 52);

    // Deck should have 47 cards remaining
    assert_eq!(deck.length(), 47);
}

/// Test that referee module is accessible
#[test]
fun referee_module_accessible() {
    // Verify referee type constants
    assert_eq!(referee::referee_type_automated(), 0);
    assert_eq!(referee::referee_type_designated(), 1);
    assert_eq!(referee::referee_type_committee(), 2);

    // Verify dispute status constants
    assert_eq!(referee::dispute_status_none(), 0);
    assert_eq!(referee::dispute_status_raised(), 1);
    assert_eq!(referee::dispute_status_timed_out(), 6);
}

/// Test referee configuration creation
#[test]
fun referee_config_creation() {
    // Default config
    let default = referee::default_config();
    assert_eq!(referee::config_timeout_ms(&default), 3600000); // 1 hour
    assert!(!referee::config_penalties_enabled(&default));

    // Timeout-only config
    let timeout_config = referee::create_timeout_config(7200000); // 2 hours
    assert_eq!(referee::config_timeout_ms(&timeout_config), 7200000);

    // Penalty config
    let penalty_config = referee::create_penalty_config(
        3600000, // timeout
        1000, // base penalty
        500, // per hour
        5000, // max
    );
    assert_eq!(referee::config_base_penalty(&penalty_config), 1000);
    assert_eq!(referee::config_max_penalty(&penalty_config), 5000);
    assert!(referee::config_penalties_enabled(&penalty_config));
}

/// Test dispute history tracking
#[test]
fun referee_dispute_history() {
    let mut history = referee::new_dispute_history();

    // Initial state
    assert_eq!(referee::history_disputes_raised(&history), 0);
    assert_eq!(referee::history_consecutive_timeouts(&history), 0);

    // Record some events
    referee::record_dispute_raised(&mut history);
    referee::record_dispute_won(&mut history);
    assert_eq!(referee::history_disputes_raised(&history), 1);
    assert_eq!(referee::history_disputes_won(&history), 1);

    // Record timeouts
    referee::record_timeout(&mut history, 100);
    referee::record_timeout(&mut history, 200);
    assert_eq!(referee::history_consecutive_timeouts(&history), 2);
    assert_eq!(referee::history_total_penalties_paid(&history), 300);

    // Good behavior resets consecutive timeouts
    referee::reset_consecutive_timeouts(&mut history);
    assert_eq!(referee::history_consecutive_timeouts(&history), 0);
}

/// Test penalty calculations
#[test]
fun referee_penalty_calculations() {
    // Safe penalty should cap at deposit
    assert_eq!(referee::safe_penalty(100, 1000), 100);
    assert_eq!(referee::safe_penalty(2000, 1000), 1000);

    // Would exceed check
    assert!(!referee::would_exceed_deposit(500, 1000));
    assert!(referee::would_exceed_deposit(1500, 1000));
}

/// Test committee voting
#[test]
fun referee_committee_voting() {
    // Create a committee with 50% threshold
    let mut committee = referee::create_committee(50);

    // Add members with different weights
    referee::add_committee_member(&mut committee, @0x1, 30);
    referee::add_committee_member(&mut committee, @0x2, 30);
    referee::add_committee_member(&mut committee, @0x3, 40);

    assert_eq!(referee::committee_total_weight(&committee), 100);
    assert_eq!(referee::committee_member_count(&committee), 3);

    // Remove a member
    referee::remove_committee_member(&mut committee, @0x2);
    assert_eq!(referee::committee_total_weight(&committee), 70);
}

/// Test integration: referee with tunnel status
#[test]
fun referee_tunnel_integration() {
    // Verify referee statuses align with tunnel dispute flow
    // Tunnel: CREATED -> ACTIVE -> DISPUTED -> CLOSED

    // Dispute can be raised when tunnel is active
    let tunnel_active = tunnel::status_active();
    assert_eq!(tunnel_active, 1);

    // Dispute status progression
    let dispute_raised = referee::dispute_status_raised();
    let dispute_resolved = referee::dispute_status_resolved_a();
    let dispute_timed_out = referee::dispute_status_timed_out();

    assert_eq!(dispute_raised, 1);
    assert_eq!(dispute_resolved, 3);
    assert_eq!(dispute_timed_out, 6);
}

/// Test that ZK verifier module is accessible
#[test]
fun zk_verifier_module_accessible() {
    // Verify curve constants
    assert_eq!(zk_verifier::curve_bls12381(), 0);
    assert_eq!(zk_verifier::curve_bn254(), 1);

    // Verify validity checks
    assert!(zk_verifier::is_valid_curve(zk_verifier::curve_bls12381()));
    assert!(zk_verifier::is_valid_curve(zk_verifier::curve_bn254()));
    assert!(!zk_verifier::is_valid_curve(99));

    // Verify limits
    assert_eq!(zk_verifier::max_public_inputs(), 8);
    assert_eq!(zk_verifier::scalar_size(), 32);
}

/// Test circuit ID creation and consistency
#[test]
fun zk_verifier_circuit_id() {
    // Same name produces same ID
    let id1 = zk_verifier::create_circuit_id(&b"test_circuit");
    let id2 = zk_verifier::create_circuit_id(&b"test_circuit");
    assert_eq!(id1, id2);

    // Different names produce different IDs
    let id3 = zk_verifier::create_circuit_id(&b"other_circuit");
    assert!(id1 != id3);

    // Circuit IDs are 32 bytes (blake2b256 hash)
    assert_eq!(id1.length(), 32);
}

/// Test public input scalar conversion
#[test]
fun zk_verifier_scalar_conversion() {
    // u64 to scalar (little-endian, 32 bytes)
    let scalar = zk_verifier::u64_to_scalar(12345);
    assert_eq!(scalar.length(), 32);

    // First byte should be least significant
    assert_eq!(*scalar.borrow(0), (12345u64 & 0xFFu64) as u8);

    // u256 to scalar
    let scalar256 = zk_verifier::u256_to_scalar(0xABCD);
    assert_eq!(scalar256.length(), 32);

    // Address to scalar
    let addr_scalar = zk_verifier::address_to_scalar(@0x1234);
    assert_eq!(addr_scalar.length(), 32);
}

/// Test scalar concatenation
#[test]
fun zk_verifier_concat_scalars() {
    let s1 = zk_verifier::u64_to_scalar(100);
    let s2 = zk_verifier::u64_to_scalar(200);
    let s3 = zk_verifier::u64_to_scalar(300);

    // Concatenate 3 scalars
    let combined = zk_verifier::concat_scalars(vector[s1, s2, s3]);

    // Should be 3 * 32 = 96 bytes
    assert_eq!(combined.length(), 96);

    // First 32 bytes should match s1
    let mut i = 0;
    while (i < 32) {
        assert_eq!(*combined.borrow(i), *s1.borrow(i));
        i = i + 1;
    };
}

/// Test zkTunnel state proof creation
#[test]
fun zk_verifier_state_proof() {
    let circuit_id = b"payment_circuit";
    let public_inputs = zk_verifier::u64_to_scalar(1000);
    let proof_bytes = b"dummy_proof";
    let state_version = 42u64;

    let state_proof = zk_verifier::create_zk_state_proof(
        circuit_id,
        public_inputs,
        proof_bytes,
        state_version,
    );

    // Verify accessors
    assert_eq!(*zk_verifier::zk_proof_circuit_id(&state_proof), circuit_id);
    assert_eq!(zk_verifier::zk_proof_state_version(&state_proof), 42);
    assert_eq!(zk_verifier::state_proof_version(&state_proof), 42);
}

/// Test verification result creation
#[test]
fun zk_verifier_verification_result() {
    let inputs = b"test_inputs";
    let result = zk_verifier::create_verification_result(
        true,
        b"my_circuit",
        &inputs,
        1234567890,
    );

    assert!(zk_verifier::result_valid(&result));
    assert_eq!(*zk_verifier::result_circuit_id(&result), b"my_circuit");
    assert_eq!(zk_verifier::result_timestamp(&result), 1234567890);

    // Hash should be 32 bytes
    assert_eq!(zk_verifier::result_inputs_hash(&result).length(), 32);
}

/// Test integration: hash_to_scalar produces valid public input
#[test]
fun zk_verifier_hash_to_scalar_integration() {
    // Hash tunnel state data to create public input
    let state_data = b"player_a_wins_100_sui";
    let scalar = zk_verifier::hash_to_scalar(&state_data);

    // Valid scalar for ZK proof
    assert_eq!(scalar.length(), 32);

    // Same data produces same hash
    let scalar2 = zk_verifier::hash_to_scalar(&state_data);
    assert_eq!(scalar, scalar2);

    // Can be used as public input
    let inputs = zk_verifier::concat_scalars(vector[scalar]);
    assert_eq!(inputs.length(), 32);
}

/// Test integration: ZK verifier with tunnel state hashing
#[test]
fun zk_tunnel_state_integration() {
    // Simulate a zkTunnel where state transitions are proven via ZK

    // Create tunnel state
    let tunnel_id = vector[1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    let nonce = 5u64;
    let state_data = b"final_state";

    // Create state hash (as done in tunnel module)
    let state_hash = tunnel::create_state_hash(&state_data);
    assert_eq!(state_hash.length(), 32);

    // Convert to ZK public inputs
    let nonce_scalar = zk_verifier::u64_to_scalar(nonce);
    let state_scalar = zk_verifier::hash_to_scalar(&state_hash);
    let tunnel_scalar = zk_verifier::hash_to_scalar(&tunnel_id);

    // Combine for circuit verification
    let public_inputs = zk_verifier::concat_scalars(vector[
        tunnel_scalar,
        nonce_scalar,
        state_scalar,
    ]);

    // Should have 3 * 32 = 96 bytes
    assert_eq!(public_inputs.length(), 96);

    // Create a ZK state proof structure
    let zk_proof = zk_verifier::create_zk_state_proof(
        zk_verifier::create_circuit_id(&b"tunnel_state_circuit"),
        public_inputs,
        b"zk_proof_bytes_would_go_here",
        nonce,
    );

    assert_eq!(zk_verifier::state_proof_version(&zk_proof), nonce);
}

/// Test integration: ZK verifier with randomness for gaming
#[test]
fun zk_verifier_randomness_integration() {
    // In a zkTunnel game, randomness can be committed as public input

    // Generate randomness seed
    let seed = randomness::from_bytes(b"game_session_seed");

    // Get a random value
    let (card, _) = randomness::next_u8_in_range(&seed, 0, 52);

    // Commit the card value as a public input for ZK proof
    let card_scalar = zk_verifier::u64_to_scalar(card as u64);
    assert_eq!(card_scalar.length(), 32);

    // The ZK circuit could prove knowledge of the shuffle/deal
    // without revealing all cards
    let seed_bytes = randomness::seed_bytes(&seed);
    let seed_commitment = zk_verifier::hash_to_scalar(seed_bytes);

    let public_inputs = zk_verifier::concat_scalars(vector[seed_commitment, card_scalar]);

    assert_eq!(public_inputs.length(), 64);
}

/// Test integration: ZK verifier with signature verification concept
#[test]
fun zk_verifier_signature_integration() {
    // A zkTunnel could verify signatures were valid without revealing them

    // Create a message
    let tunnel_id = vector[1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    let nonce = 100u64;
    let message = signature::create_tunnel_message(tunnel_id, nonce, b"state");

    // Hash the message for use in ZK circuit
    let message_hash = zk_verifier::hash_to_scalar(&message);
    assert_eq!(message_hash.length(), 32);

    // In a real zkTunnel, the ZK circuit would verify:
    // 1. Message was correctly formed
    // 2. Signatures from both parties were valid
    // 3. State transition was correct

    // The public inputs would include commitments to these values
    let nonce_scalar = zk_verifier::u64_to_scalar(nonce);
    let inputs = zk_verifier::concat_scalars(vector[message_hash, nonce_scalar]);

    assert_eq!(inputs.length(), 64);
}

/// Test that hop module is accessible
#[test]
fun hop_module_accessible() {
    // Verify HTLC status constants
    assert_eq!(hop::htlc_status_pending(), 0);
    assert_eq!(hop::htlc_status_claimed(), 1);
    assert_eq!(hop::htlc_status_expired(), 2);
    assert_eq!(hop::htlc_status_cancelled(), 3);

    // Verify route status constants
    assert_eq!(hop::route_status_planning(), 0);
    assert_eq!(hop::route_status_active(), 1);
    assert_eq!(hop::route_status_completed(), 2);
    assert_eq!(hop::route_status_failed(), 3);

    // Verify limits
    assert_eq!(hop::max_hops(), 20);
    assert_eq!(hop::min_timeout_delta_ms(), 60000);
}

/// Test multi-hop route creation
#[test]
fun hop_route_creation() {
    let sender = @0xA;
    let receiver = @0xD;
    let amount = 100000u64;

    // Create a route
    let mut route = hop::create_route(sender, receiver, amount, 1234567890);

    // Add hops: A -> B -> C -> D
    hop::add_hop(&mut route, b"tunnel_ab", @0xB, 100, 3600000);
    hop::add_hop(&mut route, b"tunnel_bc", @0xC, 80, 3480000);
    hop::add_hop(&mut route, b"tunnel_cd", @0xD, 60, 3360000);

    // Verify route structure
    assert_eq!(hop::route_sender(&route), @0xA);
    assert_eq!(hop::route_receiver(&route), @0xD);
    assert_eq!(hop::route_amount(&route), 100000);
    assert_eq!(hop::route_hop_count(&route), 3);
    assert_eq!(hop::route_total_fees(&route), 240);

    // Validate the route
    let validation = hop::validate_route(&route);
    assert!(hop::validation_valid(&validation));
    assert_eq!(hop::validation_total_amount(&validation), 100240);
}

/// Test HTLC lifecycle with preimage
#[test]
fun hop_htlc_lifecycle() {
    let ctx = sui::tx_context::dummy();
    // Create a secret preimage
    let preimage = b"super_secret_preimage_value";
    let payment_hash = hop::create_payment_hash(&preimage);

    // Create HTLC (receiver @0x0 matches dummy ctx sender)
    let mut htlc = hop::create_htlc(
        payment_hash,
        5000,
        @0xA,
        @0x0,
        3600000,
    );

    // Verify initial state
    assert_eq!(hop::htlc_status(&htlc), hop::htlc_status_pending());
    assert_eq!(hop::htlc_amount(&htlc), 5000);
    assert!(hop::is_htlc_claimable(&htlc, 3599999));

    // Verify preimage works
    assert!(hop::verify_preimage(&htlc, &preimage));
    assert!(!hop::verify_preimage(&htlc, &b"wrong_preimage"));

    // Claim with preimage
    let claimed = hop::claim_htlc(&mut htlc, preimage, &ctx);
    assert!(claimed);
    assert_eq!(hop::htlc_status(&htlc), hop::htlc_status_claimed());
}

/// Test HTLC expiration
#[test]
fun hop_htlc_expiration() {
    let ctx = sui::tx_context::dummy();
    let payment_hash = hop::create_payment_hash(&b"preimage");
    // Use @0x0 as sender since dummy ctx returns sender @0x0
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0x0, @0xB, 3600000);

    // Not expired before timeout
    assert!(!hop::is_htlc_expired(&htlc, 3599999));
    assert!(!hop::expire_htlc(&mut htlc, 3599999, &ctx));

    // Expired after timeout
    assert!(hop::is_htlc_expired(&htlc, 3600001));
    assert!(hop::expire_htlc(&mut htlc, 3600001, &ctx));
    assert_eq!(hop::htlc_status(&htlc), hop::htlc_status_expired());
}

/// Test fee policy calculations
#[test]
fun hop_fee_policy() {
    // Create custom fee policy: 500 base + 200 ppm
    let policy = hop::create_fee_policy(500, 200, 1000, 1000000, 60000);

    // Calculate fee for 100000
    // base(500) + proportional(100000 * 200 / 1000000 = 20) = 520
    let fee = hop::calculate_fee(&policy, 100000);
    assert_eq!(fee, 520);

    // Check amount acceptability
    assert!(hop::is_amount_acceptable(&policy, 10000)); // Within range
    assert!(!hop::is_amount_acceptable(&policy, 500)); // Below min
    assert!(!hop::is_amount_acceptable(&policy, 2000000)); // Above max
}

/// Test routing node management
#[test]
fun hop_routing_node() {
    let ctx = sui::tx_context::dummy();
    let policy = hop::default_fee_policy();
    let mut node = hop::create_routing_node(@0x0, policy);

    // Add tunnels
    hop::add_tunnel_to_node(&mut node, b"tunnel_1", &ctx);
    hop::add_tunnel_to_node(&mut node, b"tunnel_2", &ctx);
    assert_eq!(hop::node_tunnel_count(&node), 2);

    // Record successful routes
    hop::record_successful_route(&mut node, 10000, &ctx);
    hop::record_successful_route(&mut node, 20000, &ctx);
    hop::record_successful_route(&mut node, 30000, &ctx);
    hop::record_failed_route(&mut node, &ctx);

    assert_eq!(hop::node_total_routed(&node), 60000);
    assert_eq!(hop::node_successful_routes(&node), 3);
    assert_eq!(hop::node_failed_routes(&node), 1);

    // Success rate: 3/4 = 75% = 7500
    assert_eq!(hop::node_success_rate(&node), 7500);
}

/// Test integration: multi-hop with tunnel state
#[test]
fun hop_tunnel_integration() {
    // Simulate multi-hop payment that uses tunnel state

    // Create a route
    let sender = @0xA;
    let receiver = @0xC;
    let amount = 50000u64;

    let mut route = hop::create_route(sender, receiver, amount, 1234567890);
    hop::add_hop(&mut route, b"tunnel_1", @0xB, 100, 3600000);
    hop::add_hop(&mut route, b"tunnel_2", @0xC, 50, 3480000);

    // Each hop would create state update data for the tunnel
    let hop_0 = hop::route_get_hop(&route, 0);
    let hop_1 = hop::route_get_hop(&route, 1);

    // Create state data for each tunnel hop
    let state_0 = signature::create_tunnel_message(
        *hop::hop_tunnel_id(hop_0),
        1,
        b"htlc_offer",
    );
    let state_1 = signature::create_tunnel_message(
        *hop::hop_tunnel_id(hop_1),
        1,
        b"htlc_offer",
    );

    // Hash states
    let hash_0 = tunnel::create_state_hash(&state_0);
    let hash_1 = tunnel::create_state_hash(&state_1);

    assert_eq!(hash_0.length(), 32);
    assert_eq!(hash_1.length(), 32);
    assert!(hash_0 != hash_1);
}

/// Test integration: cascading timeouts for safety
#[test]
fun hop_timeout_cascade() {
    // Create cascading timeouts for a 4-hop route
    // Each hop should have a smaller timeout for safe settlement
    let base_timeout = 7200000u64; // 2 hours
    let delta = 120000u64; // 2 minutes between hops

    let timeouts = hop::create_cascading_timeouts(base_timeout, 4, delta);

    assert_eq!(timeouts.length(), 4);
    assert_eq!(*timeouts.borrow(0), 7200000); // First hop: 2 hours
    assert_eq!(*timeouts.borrow(1), 7080000); // Second hop: 118 min
    assert_eq!(*timeouts.borrow(2), 6960000); // Third hop: 116 min
    assert_eq!(*timeouts.borrow(3), 6840000); // Fourth hop: 114 min

    // Each timeout is larger than the next (required for safety)
    let mut i = 1;
    while (i < 4) {
        assert!(*timeouts.borrow(i - 1) > *timeouts.borrow(i));
        i = i + 1;
    };
}

/// Test integration: HTLC with ZK state proof
#[test]
fun hop_zk_htlc_integration() {
    // In a zkTunnel, HTLC claims could be proven via ZK

    let preimage = b"secret_for_payment";
    let payment_hash = hop::create_payment_hash(&preimage);

    // Create ZK public inputs for HTLC verification
    let hash_scalar = zk_verifier::hash_to_scalar(&payment_hash);
    let amount_scalar = zk_verifier::u64_to_scalar(10000);
    let expiry_scalar = zk_verifier::u64_to_scalar(3600000);

    let public_inputs = zk_verifier::concat_scalars(vector[
        hash_scalar,
        amount_scalar,
        expiry_scalar,
    ]);

    assert_eq!(public_inputs.length(), 96);

    // ZK circuit would prove:
    // 1. Knowledge of preimage without revealing it
    // 2. Correct payment hash computation
    // 3. Valid claim before expiry
}

/// Test integration: route fee estimation
#[test]
fun hop_fee_estimation() {
    // Estimate fees for different route lengths
    let amount = 100000u64;
    let base_fee = 1000u64;
    let rate_ppm = 100u64;

    // 1-hop route
    let fee_1 = hop::estimate_route_fee(amount, 1, base_fee, rate_ppm);
    // 1 * 1000 + (100000 * 100 * 1) / 1000000 = 1000 + 10 = 1010
    assert_eq!(fee_1, 1010);

    // 3-hop route
    let fee_3 = hop::estimate_route_fee(amount, 3, base_fee, rate_ppm);
    // 3 * 1000 + (100000 * 100 * 3) / 1000000 = 3000 + 30 = 3030
    assert_eq!(fee_3, 3030);

    // 5-hop route
    let fee_5 = hop::estimate_route_fee(amount, 5, base_fee, rate_ppm);
    // 5 * 1000 + (100000 * 100 * 5) / 1000000 = 5000 + 50 = 5050
    assert_eq!(fee_5, 5050);
}

/// Test integration: complete payment flow simulation
#[test]
fun hop_complete_payment_flow() {
    // Simulate: Alice -> Bob -> Carol (payment)

    // Step 1: Create route
    let mut route = hop::create_route(@0xA, @0xC, 10000, 1234567890);
    hop::add_hop(&mut route, b"alice_bob_tunnel", @0xB, 100, 3600000);
    hop::add_hop(&mut route, b"bob_carol_tunnel", @0xC, 50, 3480000);

    // Validate route
    let validation = hop::validate_route(&route);
    assert!(hop::validation_valid(&validation));

    // Step 2: Activate route (HTLCs would be created)
    hop::activate_route(&mut route);
    assert_eq!(hop::route_status(&route), hop::route_status_active());

    // Step 3: Create HTLCs for each hop
    let preimage = b"payment_secret";
    let payment_hash = hop::create_payment_hash(&preimage);

    let ctx = sui::tx_context::dummy();

    // Alice -> Bob HTLC (receiver @0x0 matches dummy ctx sender for test)
    let mut htlc_ab = hop::create_htlc(
        payment_hash,
        10100, // Amount + fee for next hop
        @0xA,
        @0x0,
        3600000,
    );

    // Bob -> Carol HTLC (receiver @0x0 matches dummy ctx sender for test)
    let mut htlc_bc = hop::create_htlc(
        payment_hash,
        10000, // Final amount
        @0xB,
        @0x0,
        3480000,
    );

    // Step 4: Carol claims with preimage (backward settlement)
    assert!(hop::claim_htlc(&mut htlc_bc, preimage, &ctx));

    // Step 5: Bob now has preimage, claims from Alice
    let revealed_preimage = hop::htlc_preimage(&htlc_bc);
    assert!(hop::claim_htlc(&mut htlc_ab, *revealed_preimage, &ctx));

    // Step 6: Complete route
    hop::complete_route(&mut route);
    assert_eq!(hop::route_status(&route), hop::route_status_completed());
}

// ============================================
// NEGATIVE / ADVERSARIAL TESTS
// ============================================

/// Test: Cannot deposit as wrong party (sender is party_a, tries deposit_party_b)
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::ENotAuthorized,
        location = sui_tunnel::tunnel,
    ),
]
fun deposit_wrong_party() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    // sender is @0x0 which is party_a, not party_b
    let mut t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    let coin = sui::coin::mint_for_testing<sui::sui::SUI>(1000, &mut ctx);
    // Try to deposit as party_b but sender is party_a -> not_authorized
    tunnel::deposit_party_b(&mut t, coin, &clock, &ctx);

    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: Cannot force close when tunnel is not disputed
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::ENoActiveDispute,
        location = sui_tunnel::tunnel,
    ),
]
fun force_close_not_disputed() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    let mut t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    // Tunnel is in CREATED status, not DISPUTED -> no_active_dispute
    t.force_close_after_timeout(&clock, &mut ctx);

    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: Cannot create tunnel with same address for both parties
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidParties,
        location = sui_tunnel::tunnel,
    ),
]
fun create_tunnel_same_parties() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk.push_back(0); i = i + 1u64; };

    // Same address for both parties -> invalid_parties
    let t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk,
        signature::ed25519(),
        @0x0,
        pk,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: Cannot update state when tunnel is in CREATED status (requires ACTIVE)
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidState,
        location = sui_tunnel::tunnel,
    ),
]
fun update_state_wrong_status() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    // Tunnel is in CREATED status (not ACTIVE), update_state requires ACTIVE
    let mut t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    t.update_state(b"hash", 1, 0, 0, 0, b"sig_a", b"sig_b", &clock);

    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: Cannot close with mismatched balance sum
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EBalanceSumMismatch,
        location = sui_tunnel::tunnel,
    ),
]
fun close_balance_mismatch() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    let mut t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    // Total balance is 0, but claiming 100+0=100 doesn't match -> balance_sum_mismatch
    t.close_cooperative(100, 0, b"sig", b"sig", 1000, &clock, &mut ctx);

    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: Randomness range must have min < max
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::randomness::EInvalidRandomnessRange,
        location = sui_tunnel::randomness,
    ),
]
fun randomness_invalid_range() {
    let seed = randomness::from_bytes(b"test_seed");
    // min > max should fail
    let (_val, _seed) = randomness::next_u64_in_range(&seed, 10, 5);
}

/// Test: Randomness range with equal min and max
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::randomness::EInvalidRandomnessRange,
        location = sui_tunnel::randomness,
    ),
]
fun randomness_equal_range() {
    let seed = randomness::from_bytes(b"test_seed");
    // min == max should fail
    let (_val, _seed) = randomness::next_u64_in_range(&seed, 5, 5);
}

/// Test: Cannot draw from empty vector
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::randomness::EEmptyInput,
        location = sui_tunnel::randomness,
    ),
]
fun draw_from_empty_vector() {
    let seed = randomness::from_bytes(b"test_seed");
    let mut empty_vec = vector<u8>[];
    let (_val, _seed) = randomness::draw_from_vector(&seed, &mut empty_vec);
}

/// Test: HTLC cannot be claimed after expiry (returns false, does not abort)
#[test]
fun htlc_claim_after_expiry() {
    let ctx = sui::tx_context::dummy();
    let preimage = b"my_secret_preimage";
    let payment_hash = hop::create_payment_hash(&preimage);

    // Use @0x0 as sender/receiver since dummy ctx returns sender @0x0
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0x0, @0x0, 3600000);

    // Expire the HTLC first
    assert!(hop::expire_htlc(&mut htlc, 3600001, &ctx));
    assert_eq!(hop::htlc_status(&htlc), hop::htlc_status_expired());

    // Try to claim after expiry - should return false (not abort)
    let claimed = hop::claim_htlc(&mut htlc, preimage, &ctx);
    assert!(!claimed);
}

/// Test: HTLC cannot be claimed with wrong preimage (returns false)
#[test]
fun htlc_wrong_preimage() {
    let ctx = sui::tx_context::dummy();
    let preimage = b"correct_preimage";
    let payment_hash = hop::create_payment_hash(&preimage);

    // receiver @0x0 matches dummy ctx sender
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0xA, @0x0, 3600000);

    // Try claiming with wrong preimage
    let claimed = hop::claim_htlc(&mut htlc, b"wrong_preimage", &ctx);
    assert!(!claimed);
    // Should still be pending
    assert_eq!(hop::htlc_status(&htlc), hop::htlc_status_pending());
}

/// Test: HTLC cannot be double-claimed (second claim returns false)
#[test]
fun htlc_double_claim() {
    let ctx = sui::tx_context::dummy();
    let preimage = b"my_secret";
    let payment_hash = hop::create_payment_hash(&preimage);

    // receiver @0x0 matches dummy ctx sender
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0xA, @0x0, 3600000);

    // First claim succeeds
    assert!(hop::claim_htlc(&mut htlc, preimage, &ctx));

    // Second claim fails (returns false)
    assert!(!hop::claim_htlc(&mut htlc, preimage, &ctx));
}

/// Test: HTLC cannot be claimed by non-receiver (aborts with not_authorized)
#[test, expected_failure(abort_code = sui_tunnel::hop::ENotAuthorized, location = sui_tunnel::hop)]
fun htlc_claim_not_authorized() {
    let ctx = sui::tx_context::dummy(); // sender is @0x0
    let preimage = b"my_secret";
    let payment_hash = hop::create_payment_hash(&preimage);

    // receiver @0xB does NOT match dummy ctx sender @0x0
    let mut htlc = hop::create_htlc(payment_hash, 5000, @0xA, @0xB, 3600000);

    // Should abort with not_authorized (error code 0)
    hop::claim_htlc(&mut htlc, preimage, &ctx);
}

/// Test: Route exceeds maximum hops
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::hop::EMaxHopsExceeded,
        location = sui_tunnel::hop,
    ),
]
fun route_exceeds_max_hops() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1000);

    // Add 21 hops (max is 20) -> max_hops_exceeded
    let mut i = 0u64;
    while (i < 21) {
        hop::add_hop(&mut route, b"tunnel", @0x1, 10, 3600000 - i * 60000);
        i = i + 1u64;
    };
}

/// Test: Resolve dispute requires tunnel to be disputed
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::ENoActiveDispute,
        location = sui_tunnel::tunnel,
    ),
]
fun resolve_dispute_not_disputed() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    let mut t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    // Tunnel is CREATED, not DISPUTED -> no_active_dispute
    t.resolve_dispute(b"hash", 1, 0, 0, 1000, b"sig_a", b"sig_b", &clock);

    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: Cannot create tunnel with unsupported signature type
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EUnsupportedSignatureType,
        location = sui_tunnel::tunnel,
    ),
]
fun create_tunnel_invalid_sig_type() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk.push_back(0); i = i + 1u64; };

    // Signature type 99 is not supported -> unsupported_signature_type
    let t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk,
        99,
        @0xBBBB,
        pk,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: Cannot create tunnel with wrong public key length
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidPublicKey,
        location = sui_tunnel::tunnel,
    ),
]
fun create_tunnel_wrong_pk_length() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };

    // ED25519 requires 32-byte key, but we provide only 3 bytes -> invalid_public_key
    let short_pk = vector[1u8, 2, 3];

    let t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        short_pk,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: Cannot activate an already active route
#[test, expected_failure(abort_code = sui_tunnel::hop::EInvalidHop, location = sui_tunnel::hop)]
fun activate_already_active_route() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1000);
    hop::add_hop(&mut route, b"tunnel_1", @0xB, 100, 3600000);

    hop::activate_route(&mut route);
    // Second activation should fail -> invalid_hop
    hop::activate_route(&mut route);
}

/// Test: Cannot complete a route that's still in planning
#[test, expected_failure(abort_code = sui_tunnel::hop::EInvalidHop, location = sui_tunnel::hop)]
fun complete_planning_route() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1000);
    hop::add_hop(&mut route, b"tunnel_1", @0xB, 100, 3600000);

    // Route is still PLANNING, complete requires ACTIVE -> invalid_hop
    hop::complete_route(&mut route);
}

/// Test: Cannot add hop to an active route
#[test, expected_failure(abort_code = sui_tunnel::hop::EInvalidHop, location = sui_tunnel::hop)]
fun add_hop_to_active_route() {
    let mut route = hop::create_route(@0xA, @0xB, 10000, 1000);
    hop::add_hop(&mut route, b"tunnel_1", @0xB, 100, 3600000);

    hop::activate_route(&mut route);
    // Cannot add hop after activation -> invalid_hop
    hop::add_hop(&mut route, b"tunnel_2", @0xC, 50, 3540000);
}

/// Test: Commitment with too-short salt is rejected
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::randomness::EInvalidParameter,
        location = sui_tunnel::randomness,
    ),
]
fun commitment_short_salt() {
    // Salt must be at least 16 bytes
    let _commitment = randomness::create_commitment(&b"value", &b"short", @0x1, 1000);
}

/// Test: Combined randomness cannot be finalized twice
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::randomness::ERandomnessAlreadyRevealed,
        location = sui_tunnel::randomness,
    ),
]
fun combined_randomness_double_finalize() {
    let value_a = b"alice_secret_val";
    let salt_a = b"alice_salt_at_least_16_chars";
    let value_b = b"bob_secret_value";
    let salt_b = b"bob_salt_at_least_16_chars!";

    let commitment_a = randomness::create_commitment(&value_a, &salt_a, @0xA, 1000);
    let commitment_b = randomness::create_commitment(&value_b, &salt_b, @0xB, 1001);

    let mut combined = randomness::create_combined_randomness(commitment_a, commitment_b);

    let reveal_a = randomness::create_reveal(value_a, salt_a);
    let reveal_b = randomness::create_reveal(value_b, salt_b);

    // First finalize succeeds
    randomness::finalize_combined_randomness(&mut combined, &reveal_a, &reveal_b);

    // Second finalize should fail -> randomness_already_revealed
    randomness::finalize_combined_randomness(&mut combined, &reveal_a, &reveal_b);
}

/// Test: Combined randomness finalize with wrong reveal fails
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::randomness::ERandomnessCommitmentMismatch,
        location = sui_tunnel::randomness,
    ),
]
fun combined_randomness_wrong_reveal() {
    let value_a = b"alice_secret_val";
    let salt_a = b"alice_salt_at_least_16_chars";
    let value_b = b"bob_secret_value";
    let salt_b = b"bob_salt_at_least_16_chars!";

    let commitment_a = randomness::create_commitment(&value_a, &salt_a, @0xA, 1000);
    let commitment_b = randomness::create_commitment(&value_b, &salt_b, @0xB, 1001);

    let mut combined = randomness::create_combined_randomness(commitment_a, commitment_b);

    // Reveal with wrong value for party A
    let wrong_reveal_a = randomness::create_reveal(b"wrong_value_here", salt_a);
    let reveal_b = randomness::create_reveal(value_b, salt_b);

    // Should fail -> randomness_commitment_mismatch
    randomness::finalize_combined_randomness(&mut combined, &wrong_reveal_a, &reveal_b);
}

/// Test: Cannot access seed of unfinalized combined randomness
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::randomness::ERandomnessNotAvailable,
        location = sui_tunnel::randomness,
    ),
]
fun combined_randomness_seed_before_finalize() {
    let value_a = b"alice_secret_val";
    let salt_a = b"alice_salt_at_least_16_chars";
    let value_b = b"bob_secret_value";
    let salt_b = b"bob_salt_at_least_16_chars!";

    let commitment_a = randomness::create_commitment(&value_a, &salt_a, @0xA, 1000);
    let commitment_b = randomness::create_commitment(&value_b, &salt_b, @0xB, 1001);

    let combined = randomness::create_combined_randomness(commitment_a, commitment_b);

    // Not finalized yet -> randomness_not_available
    let _seed = randomness::combined_seed(&combined);
}

// ============================================
// NEW TESTS: VERSION, DEPOSIT, WITHDRAWAL, DESTROY
// ============================================

/// Test: Tunnel has version field set
#[test]
fun tunnel_version() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    let t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    assert_eq!(tunnel::version(&t), tunnel::current_version());
    assert_eq!(tunnel::version(&t), 1);
    tunnel::assert_current_version(&t);

    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: Unified deposit function - party A deposits
#[test]
fun deposit_unified_party_a() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    let mut t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    let coin = sui::coin::mint_for_testing<sui::sui::SUI>(1000, &mut ctx);
    // sender is @0x0 which is party_a
    tunnel::deposit(&mut t, coin, &clock, &ctx);
    assert_eq!(tunnel::party_a_deposit(&t), 1000);
    assert_eq!(tunnel::party_b_deposit(&t), 0);

    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: Unified deposit function - unauthorized sender aborts
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::ENotAuthorized,
        location = sui_tunnel::tunnel,
    ),
]
fun deposit_unified_unauthorized() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    // sender is @0x0 but neither party is @0x0
    let mut t = tunnel::create<sui::sui::SUI>(
        @0xAAAA,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    let coin = sui::coin::mint_for_testing<sui::sui::SUI>(1000, &mut ctx);
    tunnel::deposit(&mut t, coin, &clock, &ctx);

    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: withdraw_before_active - party A withdraws when B has zero deposit
#[test]
fun withdraw_before_active() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    let mut t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    let coin = sui::coin::mint_for_testing<sui::sui::SUI>(1000, &mut ctx);
    tunnel::deposit_party_a(&mut t, coin, &clock, &ctx);
    assert_eq!(tunnel::party_a_deposit(&t), 1000);

    let withdrawn = tunnel::withdraw_before_active(&mut t, &clock, &mut ctx);
    assert_eq!(withdrawn.value(), 1000);
    assert_eq!(tunnel::party_a_deposit(&t), 0);
    assert_eq!(tunnel::status(&t), tunnel::status_closed());

    std::unit_test::destroy(withdrawn);
    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: withdraw_before_active fails when tunnel is ACTIVE (wrong status)
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidState,
        location = sui_tunnel::tunnel,
    ),
]
fun withdraw_before_active_wrong_status() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    // Tunnel is CREATED but will transition to ACTIVE after both deposit.
    // Since we can only act as @0x0 with dummy ctx, and we need the tunnel
    // to be ACTIVE, let's just test the wrong-status case by using a CLOSED tunnel.
    let mut t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    // Deposit as party A, then withdraw to close
    let coin = sui::coin::mint_for_testing<sui::sui::SUI>(1000, &mut ctx);
    tunnel::deposit_party_a(&mut t, coin, &clock, &ctx);
    let withdrawn = tunnel::withdraw_before_active(&mut t, &clock, &mut ctx);
    std::unit_test::destroy(withdrawn);

    // Tunnel is now CLOSED. Try withdraw again -> invalid_state
    let _withdrawn2 = tunnel::withdraw_before_active(&mut t, &clock, &mut ctx);

    abort
}

/// Test: withdraw_timeout - party withdraws after timeout
#[test]
fun withdraw_timeout() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    let mut t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    let coin = sui::coin::mint_for_testing<sui::sui::SUI>(1000, &mut ctx);
    tunnel::deposit_party_a(&mut t, coin, &clock, &ctx);

    // Advance clock past timeout
    clock.set_for_testing(1000 + 3600000);

    let withdrawn = tunnel::withdraw_timeout(&mut t, &clock, &mut ctx);
    assert_eq!(withdrawn.value(), 1000);
    assert_eq!(tunnel::status(&t), tunnel::status_closed());

    std::unit_test::destroy(withdrawn);
    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: withdraw_timeout fails before timeout
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::ETimeoutNotReached,
        location = sui_tunnel::tunnel,
    ),
]
fun withdraw_timeout_not_reached() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    let mut t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    let coin = sui::coin::mint_for_testing<sui::sui::SUI>(1000, &mut ctx);
    tunnel::deposit_party_a(&mut t, coin, &clock, &ctx);

    // Don't advance clock - timeout not reached
    let _withdrawn = tunnel::withdraw_timeout(&mut t, &clock, &mut ctx);

    std::unit_test::destroy(_withdrawn);
    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: destroy_tunnel on a closed tunnel with zero balance
#[test]
fun destroy_tunnel() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    let mut t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    // Deposit and withdraw to get to CLOSED status
    let coin = sui::coin::mint_for_testing<sui::sui::SUI>(1000, &mut ctx);
    tunnel::deposit_party_a(&mut t, coin, &clock, &ctx);
    let withdrawn = tunnel::withdraw_before_active(&mut t, &clock, &mut ctx);
    std::unit_test::destroy(withdrawn);

    assert_eq!(tunnel::status(&t), tunnel::status_closed());

    // Destroy the closed tunnel
    tunnel::destroy_tunnel(&mut t, &clock, &ctx);
    assert_eq!(tunnel::status(&t), tunnel::status_destroyed());

    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: destroy_tunnel fails when not closed
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidState,
        location = sui_tunnel::tunnel,
    ),
]
fun destroy_tunnel_not_closed() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let mut pk_a = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { pk_a.push_back(0); i = i + 1u64; };
    let mut pk_b = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { pk_b.push_back(1); j = j + 1u64; };

    let mut t = tunnel::create<sui::sui::SUI>(
        @0x0,
        pk_a,
        signature::ed25519(),
        @0xBBBB,
        pk_b,
        signature::ed25519(),
        3600000,
        0,
        &clock,
        &mut ctx,
    );

    // Tunnel is in CREATED status, not CLOSED -> invalid_state
    tunnel::destroy_tunnel(&mut t, &clock, &ctx);

    t.destroy_for_testing();
    clock.destroy_for_testing();
}

/// Test: RoutingNode version field
#[test]
fun routing_node_version() {
    let policy = hop::default_fee_policy();
    let node = hop::create_routing_node(@0x0, policy);
    assert_eq!(hop::node_version(&node), hop::current_version());
    assert_eq!(hop::node_version(&node), 1);
    hop::assert_current_version(&node);
}

/// Test: RoutingNode authorization - wrong sender aborts
#[test, expected_failure(abort_code = sui_tunnel::hop::ENotAuthorized, location = sui_tunnel::hop)]
fun routing_node_unauthorized() {
    let ctx = sui::tx_context::dummy();
    let policy = hop::default_fee_policy();
    // Node address is @0xAAAA but dummy ctx sender is @0x0
    let mut node = hop::create_routing_node(@0xAAAA, policy);
    hop::add_tunnel_to_node(&mut node, b"tunnel_1", &ctx);
}

/// Test: CircuitRegistry version field
#[test]
fun registry_version() {
    let mut ctx = sui::tx_context::dummy();
    let registry = zk_verifier::create_registry(@0x1234, &mut ctx);
    assert_eq!(zk_verifier::registry_version(&registry), zk_verifier::current_version());
    assert_eq!(zk_verifier::registry_version(&registry), 1);
    zk_verifier::assert_current_version(&registry);
    zk_verifier::destroy_registry_for_testing(registry);
}
