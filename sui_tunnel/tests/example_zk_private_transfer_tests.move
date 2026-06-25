#[test_only]
module sui_tunnel::example_zk_private_transfer_tests;

use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::coin::{Self, Coin};
use sui::groth16;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::example_zk_private_transfer;
use sui_tunnel::tunnel;
use sui_tunnel::zk_verifier;

#[test]
fun circuit_type_constants() {
    assert_eq!(example_zk_private_transfer::circuit_balance_transfer(), 0);
    assert_eq!(example_zk_private_transfer::circuit_range_proof(), 1);
    assert_eq!(example_zk_private_transfer::circuit_ownership_proof(), 2);
}

#[test]
fun transfer_status_constants() {
    assert_eq!(example_zk_private_transfer::transfer_pending(), 0);
    assert_eq!(example_zk_private_transfer::transfer_verified(), 1);
    assert_eq!(example_zk_private_transfer::transfer_failed(), 2);
}

#[test]
fun balance_transfer_config() {
    let config = example_zk_private_transfer::balance_transfer_config();
    assert_eq!(*example_zk_private_transfer::config_name(&config), b"balance_transfer");
    assert_eq!(example_zk_private_transfer::config_circuit_type(&config), 0);
    assert_eq!(example_zk_private_transfer::config_num_inputs(&config), 3);
    assert_eq!(example_zk_private_transfer::config_curve_type(&config), zk_verifier::curve_bn254());
}

#[test]
fun range_proof_config() {
    let config = example_zk_private_transfer::range_proof_config();
    assert_eq!(*example_zk_private_transfer::config_name(&config), b"range_proof");
    assert_eq!(example_zk_private_transfer::config_circuit_type(&config), 1);
    assert_eq!(example_zk_private_transfer::config_num_inputs(&config), 2);
}

#[test]
fun ownership_proof_config() {
    let config = example_zk_private_transfer::ownership_proof_config();
    assert_eq!(*example_zk_private_transfer::config_name(&config), b"ownership_proof");
    assert_eq!(example_zk_private_transfer::config_circuit_type(&config), 2);
    assert_eq!(example_zk_private_transfer::config_num_inputs(&config), 1);
    assert_eq!(
        example_zk_private_transfer::config_curve_type(&config),
        zk_verifier::curve_bls12381(),
    );
}

#[test]
fun get_circuit_config() {
    let bt = example_zk_private_transfer::get_circuit_config(0);
    assert_eq!(example_zk_private_transfer::config_circuit_type(&bt), 0);

    let rp = example_zk_private_transfer::get_circuit_config(1);
    assert_eq!(example_zk_private_transfer::config_circuit_type(&rp), 1);

    let op = example_zk_private_transfer::get_circuit_config(2);
    assert_eq!(example_zk_private_transfer::config_circuit_type(&op), 2);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_private_transfer::EInvalidParameter,
        location = sui_tunnel::example_zk_private_transfer,
    ),
]
fun get_circuit_config_invalid() {
    let _ = example_zk_private_transfer::get_circuit_config(99);
}

#[test]
fun build_transfer_inputs() {
    let inputs = example_zk_private_transfer::build_transfer_inputs(@0x1, @0x2, 1000);

    // 3 scalars * 32 bytes = 96 bytes
    assert_eq!(inputs.length(), 96);

    // Same inputs should produce same result
    let inputs2 = example_zk_private_transfer::build_transfer_inputs(@0x1, @0x2, 1000);
    assert_eq!(inputs, inputs2);

    // Different inputs should produce different result
    let inputs3 = example_zk_private_transfer::build_transfer_inputs(@0x1, @0x2, 2000);
    assert!(inputs != inputs3);
}

#[test]
fun build_range_proof_inputs() {
    let inputs = example_zk_private_transfer::build_range_proof_inputs(0, 1000);

    // 2 scalars * 32 bytes = 64 bytes
    assert_eq!(inputs.length(), 64);

    // Same inputs should produce same result
    let inputs2 = example_zk_private_transfer::build_range_proof_inputs(0, 1000);
    assert_eq!(inputs, inputs2);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_private_transfer::EInvalidParameter,
        location = sui_tunnel::example_zk_private_transfer,
    ),
]
fun build_range_proof_inputs_invalid_range() {
    // min > max should fail
    let _ = example_zk_private_transfer::build_range_proof_inputs(1000, 500);
}

#[test]
fun build_ownership_proof_inputs() {
    let inputs = example_zk_private_transfer::build_ownership_proof_inputs(@0xABCD);

    // 1 scalar * 32 bytes = 32 bytes
    assert_eq!(inputs.length(), 32);

    // Same address should produce same result
    let inputs2 = example_zk_private_transfer::build_ownership_proof_inputs(@0xABCD);
    assert_eq!(inputs, inputs2);

    // Different address should produce different result
    let inputs3 = example_zk_private_transfer::build_ownership_proof_inputs(@0x1234);
    assert!(inputs != inputs3);
}

#[test]
fun commit_amount() {
    let blinding = b"random_blinding_factor";
    let commitment1 = example_zk_private_transfer::commit_amount(1000, &blinding);

    // Should be 32 bytes (blake2b256)
    assert_eq!(commitment1.length(), 32);

    // Same amount and blinding should produce same commitment
    let commitment2 = example_zk_private_transfer::commit_amount(1000, &blinding);
    assert_eq!(commitment1, commitment2);

    // Different amount should produce different commitment
    let commitment3 = example_zk_private_transfer::commit_amount(2000, &blinding);
    assert!(commitment1 != commitment3);

    // Different blinding should produce different commitment
    let blinding2 = b"different_blinding_factor";
    let commitment4 = example_zk_private_transfer::commit_amount(1000, &blinding2);
    assert!(commitment1 != commitment4);
}

#[test]
fun setup_registry() {
    let mut ctx = sui::tx_context::dummy();
    let registry = example_zk_private_transfer::setup_registry(@0x1234, &mut ctx);
    assert_eq!(zk_verifier::registry_owner(&registry), @0x1234);
    assert_eq!(zk_verifier::registry_circuit_count(&registry), 0);

    // Clean up
    zk_verifier::destroy_registry_for_testing(registry);
}

#[test]
fun get_circuit_id_deterministic() {
    let id1 = example_zk_private_transfer::get_circuit_id(&b"balance_transfer");
    let id2 = example_zk_private_transfer::get_circuit_id(&b"balance_transfer");
    assert_eq!(id1, id2);

    let id3 = example_zk_private_transfer::get_circuit_id(&b"range_proof");
    assert!(id1 != id3);

    // Should be 32 bytes
    assert_eq!(id1.length(), 32);
}

#[test]
fun submit_transfer() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let circuit_id = example_zk_private_transfer::get_circuit_id(&b"balance_transfer");
    // Sender is @0x0 (dummy ctx), receiver must be different
    let inputs = example_zk_private_transfer::build_transfer_inputs(@0x0, @0x2, 1000);

    let transfer = example_zk_private_transfer::submit_transfer(
        @0x2,
        circuit_id,
        inputs,
        b"fake_proof_bytes",
        &clock,
        &mut ctx,
    );

    assert_eq!(example_zk_private_transfer::transfer_sender(&transfer), @0x0);
    assert_eq!(example_zk_private_transfer::transfer_receiver(&transfer), @0x2);
    assert_eq!(example_zk_private_transfer::transfer_status(&transfer), 0); // TRANSFER_PENDING
    assert_eq!(example_zk_private_transfer::transfer_created_at(&transfer), 0);
    assert_eq!(example_zk_private_transfer::transfer_verified_at(&transfer), 0);
    assert_eq!(*example_zk_private_transfer::transfer_circuit_id(&transfer), circuit_id);
    assert_eq!(*example_zk_private_transfer::transfer_public_inputs(&transfer), inputs);

    example_zk_private_transfer::destroy_transfer_for_testing(transfer);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_private_transfer::EInvalidParties,
        location = sui_tunnel::example_zk_private_transfer,
    ),
]
fun submit_transfer_same_sender_receiver() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    // dummy ctx sender is @0x0, so receiver @0x0 triggers same-address error
    let transfer = example_zk_private_transfer::submit_transfer(
        @0x0, // same as ctx.sender()
        b"circuit_id",
        b"inputs",
        b"proof",
        &clock,
        &mut ctx,
    );
    example_zk_private_transfer::destroy_transfer_for_testing(transfer);

    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_private_transfer::EEmptyInput,
        location = sui_tunnel::example_zk_private_transfer,
    ),
]
fun submit_transfer_empty_proof() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let transfer = example_zk_private_transfer::submit_transfer(
        @0x2,
        b"circuit_id",
        b"inputs",
        vector[], // empty proof
        &clock,
        &mut ctx,
    );
    example_zk_private_transfer::destroy_transfer_for_testing(transfer);

    clock::destroy_for_testing(clock);
}

#[test]
fun log_verification() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let transfer = example_zk_private_transfer::submit_transfer(
        @0x2,
        b"circuit_id",
        b"some_inputs",
        b"proof_bytes",
        &clock,
        &mut ctx,
    );

    let log = example_zk_private_transfer::log_verification(&transfer, &clock, &mut ctx);

    assert_eq!(example_zk_private_transfer::log_transfer_id(&log), object::id(&transfer));
    assert_eq!(*example_zk_private_transfer::log_circuit_id(&log), b"circuit_id");
    assert!(!example_zk_private_transfer::log_success(&log)); // pending transfer = not verified
    assert_eq!(example_zk_private_transfer::log_inputs_hash(&log).length(), 32);

    example_zk_private_transfer::destroy_transfer_for_testing(transfer);
    example_zk_private_transfer::destroy_log_for_testing(log);
    clock::destroy_for_testing(clock);
}

#[test]
fun create_transfer_verification_result() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let transfer = example_zk_private_transfer::submit_transfer(
        @0x2,
        b"circuit_id",
        b"inputs",
        b"proof",
        &clock,
        &mut ctx,
    );

    let result = example_zk_private_transfer::create_transfer_verification_result(&transfer);
    assert!(!zk_verifier::result_valid(&result)); // pending
    assert_eq!(*zk_verifier::result_circuit_id(&result), b"circuit_id");

    example_zk_private_transfer::destroy_transfer_for_testing(transfer);
    clock::destroy_for_testing(clock);
}

#[test]
fun scalar_conversion_consistency() {
    // Test that u64_to_scalar produces 32-byte results
    let scalar = zk_verifier::u64_to_scalar(42);
    assert_eq!(scalar.length(), 32);

    // Test address_to_scalar produces 32-byte results
    let addr_scalar = zk_verifier::address_to_scalar(@0x1234);
    assert_eq!(addr_scalar.length(), 32);

    // Test concat_scalars with 1, 2, and 3 scalars
    let one = zk_verifier::concat_scalars(vector[scalar]);
    assert_eq!(one.length(), 32);

    let two = zk_verifier::concat_scalars(vector[scalar, addr_scalar]);
    assert_eq!(two.length(), 64);

    let three = zk_verifier::concat_scalars(vector[scalar, addr_scalar, scalar]);
    assert_eq!(three.length(), 96);
}

#[test]
fun hash_to_scalar_for_inputs() {
    let data = b"some private data";
    let scalar = zk_verifier::hash_to_scalar(&data);
    assert_eq!(scalar.length(), 32);

    // Can be used as a public input scalar
    let inputs = zk_verifier::concat_scalars(vector[scalar]);
    assert_eq!(inputs.length(), 32);
}

#[test]
fun transfer_circuit_config_accessors() {
    let config = example_zk_private_transfer::balance_transfer_config();

    assert_eq!(*example_zk_private_transfer::config_name(&config), b"balance_transfer");
    assert_eq!(example_zk_private_transfer::config_circuit_type(&config), 0);
    assert_eq!(example_zk_private_transfer::config_num_inputs(&config), 3);
    assert_eq!(example_zk_private_transfer::config_curve_type(&config), zk_verifier::curve_bn254());
    assert!(example_zk_private_transfer::config_description(&config).length() > 0);
}

#[test]
fun range_proof_boundary_values() {
    // Test range with same min and max
    let inputs = example_zk_private_transfer::build_range_proof_inputs(500, 500);
    assert_eq!(inputs.length(), 64);

    // Test range with zero min
    let inputs2 = example_zk_private_transfer::build_range_proof_inputs(0, 0);
    assert_eq!(inputs2.length(), 64);

    // Test large range
    let inputs3 = example_zk_private_transfer::build_range_proof_inputs(
        0,
        18446744073709551615,
    );
    assert_eq!(inputs3.length(), 64);
}

#[test]
fun multiple_circuit_ids_unique() {
    let id_bt = example_zk_private_transfer::get_circuit_id(&b"balance_transfer");
    let id_rp = example_zk_private_transfer::get_circuit_id(&b"range_proof");
    let id_op = example_zk_private_transfer::get_circuit_id(&b"ownership_proof");

    // All IDs should be unique
    assert!(id_bt != id_rp);
    assert!(id_bt != id_op);
    assert!(id_rp != id_op);

    // All should be 32 bytes
    assert_eq!(id_bt.length(), 32);
    assert_eq!(id_rp.length(), 32);
    assert_eq!(id_op.length(), 32);
}

// ============================================
// PROOF-GATED TRANSFER (REAL FUND MOVEMENT)
// ============================================

const PAYER: address = @0xBEEF1;
const RECEIVER: address = @0x4EC;
const PK_A: vector<u8> = x"1111111111111111111111111111111111111111111111111111111111111111";
const PK_B: vector<u8> = x"2222222222222222222222222222222222222222222222222222222222222222";
const TIMEOUT_MS: u64 = 3600000;

/// A format-valid (but not trusted-setup) PVK, mirroring zk_verifier_tests. It is
/// enough to register an active circuit; a real proof would need a real setup.
fun dummy_pvk(): groth16::PreparedVerifyingKey {
    groth16::pvk_from_bytes(b"vk_gamma_abc", b"alpha_beta", b"gamma_neg", b"delta_neg")
}

/// Registers an active balance-transfer circuit and returns the registry plus its id.
fun registry_with_circuit(
    scenario: &mut test_scenario::Scenario,
): (zk_verifier::CircuitRegistry, vector<u8>) {
    let mut registry = zk_verifier::create_registry(PAYER, scenario.ctx());
    let circuit = zk_verifier::create_circuit_with_pvk(
        b"balance_transfer",
        zk_verifier::curve_bn254(),
        dummy_pvk(),
        3,
        b"schema",
    );
    zk_verifier::register_circuit(&mut registry, circuit, scenario.ctx());
    (registry, zk_verifier::create_circuit_id(&b"balance_transfer"))
}

#[test]
fun create_zk_transfer_escrows_real_funds() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let payment = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let transfer = example_zk_private_transfer::create_zk_transfer<SUI>(
        RECEIVER,
        PK_A,
        PK_B,
        b"circuit",
        payment,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    assert_eq!(example_zk_private_transfer::zk_transfer_total_balance(&transfer), 1000);
    assert_eq!(
        example_zk_private_transfer::zk_transfer_status(&transfer),
        example_zk_private_transfer::transfer_pending(),
    );
    assert_eq!(example_zk_private_transfer::zk_transfer_payer(&transfer), PAYER);
    assert_eq!(example_zk_private_transfer::zk_transfer_receiver(&transfer), RECEIVER);
    // Only the payer has funded, so the tunnel is not yet active.
    assert!(!tunnel::is_active(example_zk_private_transfer::zk_transfer_tunnel(&transfer)));

    example_zk_private_transfer::destroy_zk_transfer_for_testing(transfer);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun cancel_transfer_refunds_payer() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let payment = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut transfer = example_zk_private_transfer::create_zk_transfer<SUI>(
        RECEIVER,
        PK_A,
        PK_B,
        b"circuit",
        payment,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    let refund = example_zk_private_transfer::cancel_transfer<SUI>(
        &mut transfer,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(refund.value(), 1000);
    assert_eq!(
        example_zk_private_transfer::zk_transfer_status(&transfer),
        example_zk_private_transfer::transfer_failed(),
    );

    refund.burn_for_testing();
    example_zk_private_transfer::destroy_zk_transfer_for_testing(transfer);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun proof_gated_release_pays_receiver() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let (registry, circuit_id) = registry_with_circuit(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut transfer = example_zk_private_transfer::create_zk_transfer<SUI>(
        RECEIVER,
        PK_A,
        PK_B,
        circuit_id,
        payment,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    // Releases the full escrow to the receiver (real on-chain payout) once the circuit
    // gate passes. Proof and signatures are bypassed here (see the helper's doc).
    example_zk_private_transfer::settle_release_no_proof_for_testing<SUI>(
        &mut transfer,
        &registry,
        0,
        1000,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(
        example_zk_private_transfer::zk_transfer_status(&transfer),
        example_zk_private_transfer::transfer_verified(),
    );

    scenario.next_tx(RECEIVER);
    let to_receiver = scenario.take_from_address<Coin<SUI>>(RECEIVER);
    assert_eq!(to_receiver.value(), 1000);
    to_receiver.burn_for_testing();

    scenario.next_tx(PAYER);
    let to_payer = scenario.take_from_address<Coin<SUI>>(PAYER);
    assert_eq!(to_payer.value(), 0);
    to_payer.burn_for_testing();

    destroy(registry);
    example_zk_private_transfer::destroy_zk_transfer_for_testing(transfer);
    clock.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_private_transfer::ECircuitNotRegistered,
        location = sui_tunnel::example_zk_private_transfer,
    ),
]
fun settle_unregistered_circuit_aborts() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    // Empty registry: the transfer's circuit is not registered.
    let registry = zk_verifier::create_registry(PAYER, scenario.ctx());

    let payment = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut transfer = example_zk_private_transfer::create_zk_transfer<SUI>(
        RECEIVER,
        PK_A,
        PK_B,
        b"unregistered",
        payment,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    example_zk_private_transfer::settle_release_no_proof_for_testing<SUI>(
        &mut transfer,
        &registry,
        0,
        1000,
        &clock,
        scenario.ctx(),
    );

    // Unreachable; present so the test type-checks.
    destroy(registry);
    example_zk_private_transfer::destroy_zk_transfer_for_testing(transfer);
    clock.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_private_transfer::EInvalidParties,
        location = sui_tunnel::example_zk_private_transfer,
    ),
]
fun create_self_transfer_aborts() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let payment = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let transfer = example_zk_private_transfer::create_zk_transfer<SUI>(
        PAYER,
        PK_A,
        PK_B,
        b"circuit",
        payment,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    // Unreachable; present so the test type-checks.
    example_zk_private_transfer::destroy_zk_transfer_for_testing(transfer);
    clock.destroy_for_testing();
    scenario.end();
}
