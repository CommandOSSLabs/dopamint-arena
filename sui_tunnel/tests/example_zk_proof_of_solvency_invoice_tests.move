#[test_only]
module sui_tunnel::example_zk_proof_of_solvency_invoice_tests;

use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::coin::{Self, Coin};
use sui::groth16;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::example_zk_proof_of_solvency_invoice;
use sui_tunnel::tunnel;
use sui_tunnel::zk_verifier;

const PAYER: address = @0xBEEF1;
const PAYEE: address = @0x4EC;
const PK_A: vector<u8> = x"1111111111111111111111111111111111111111111111111111111111111111";
const PK_B: vector<u8> = x"2222222222222222222222222222222222222222222222222222222222222222";
const TIMEOUT_MS: u64 = 3600000;

/// A format-valid (but not trusted-setup) PVK, mirroring zk_verifier_tests. It is
/// enough to register an active circuit; a real proof would need a real setup.
fun dummy_pvk(): groth16::PreparedVerifyingKey {
    groth16::pvk_from_bytes(b"vk_gamma_abc", b"alpha_beta", b"gamma_neg", b"delta_neg")
}

/// Registers an active solvency circuit and returns the registry plus its id.
fun registry_with_circuit(
    scenario: &mut test_scenario::Scenario,
): (zk_verifier::CircuitRegistry, vector<u8>) {
    let mut registry = zk_verifier::create_registry(PAYER, scenario.ctx());
    let circuit = zk_verifier::create_circuit_with_pvk(
        b"solvency",
        zk_verifier::curve_bn254(),
        dummy_pvk(),
        2,
        b"schema",
    );
    zk_verifier::register_circuit(&mut registry, circuit, scenario.ctx());
    (registry, zk_verifier::create_circuit_id(&b"solvency"))
}

#[test]
fun invoice_status_constants() {
    assert_eq!(example_zk_proof_of_solvency_invoice::invoice_pending(), 0);
    assert_eq!(example_zk_proof_of_solvency_invoice::invoice_paid(), 1);
    assert_eq!(example_zk_proof_of_solvency_invoice::invoice_cancelled(), 2);
}

#[test]
fun solvency_config() {
    let config = example_zk_proof_of_solvency_invoice::solvency_config();
    assert_eq!(*example_zk_proof_of_solvency_invoice::config_name(&config), b"solvency");
    assert_eq!(example_zk_proof_of_solvency_invoice::config_num_inputs(&config), 2);
    assert_eq!(
        example_zk_proof_of_solvency_invoice::config_curve_type(&config),
        zk_verifier::curve_bn254(),
    );
    assert!(example_zk_proof_of_solvency_invoice::config_description(&config).length() > 0);
}

#[test]
fun build_solvency_inputs() {
    let inputs = example_zk_proof_of_solvency_invoice::build_solvency_inputs(@0x1, 1000);

    // 2 scalars * 32 bytes = 64 bytes
    assert_eq!(inputs.length(), 64);

    // Same inputs should produce same result
    let inputs2 = example_zk_proof_of_solvency_invoice::build_solvency_inputs(@0x1, 1000);
    assert_eq!(inputs, inputs2);

    // Different amount should produce different result
    let inputs3 = example_zk_proof_of_solvency_invoice::build_solvency_inputs(@0x1, 2000);
    assert!(inputs != inputs3);

    // Different payer should produce different result
    let inputs4 = example_zk_proof_of_solvency_invoice::build_solvency_inputs(@0x2, 1000);
    assert!(inputs != inputs4);
}

#[test]
fun circuit_id_for_deterministic() {
    let id1 = example_zk_proof_of_solvency_invoice::circuit_id_for(&b"solvency");
    let id2 = example_zk_proof_of_solvency_invoice::circuit_id_for(&b"solvency");
    assert_eq!(id1, id2);

    let id3 = example_zk_proof_of_solvency_invoice::circuit_id_for(&b"other");
    assert!(id1 != id3);

    // Should be 32 bytes
    assert_eq!(id1.length(), 32);
}

#[test]
fun setup_registry() {
    let mut ctx = sui::tx_context::dummy();
    let registry = example_zk_proof_of_solvency_invoice::setup_registry(@0x1234, &mut ctx);
    assert_eq!(zk_verifier::registry_owner(&registry), @0x1234);
    assert_eq!(zk_verifier::registry_circuit_count(&registry), 0);

    zk_verifier::destroy_registry_for_testing(registry);
}

#[test]
fun create_invoice_payment_escrows_real_funds() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYEE,
        PK_A,
        PK_B,
        b"circuit",
        700,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    assert_eq!(example_zk_proof_of_solvency_invoice::invoice_total_balance(&payment), 1000);
    assert_eq!(
        example_zk_proof_of_solvency_invoice::invoice_status(&payment),
        example_zk_proof_of_solvency_invoice::invoice_pending(),
    );
    assert_eq!(example_zk_proof_of_solvency_invoice::invoice_payer(&payment), PAYER);
    assert_eq!(example_zk_proof_of_solvency_invoice::invoice_payee(&payment), PAYEE);
    assert_eq!(example_zk_proof_of_solvency_invoice::invoice_amount(&payment), 700);
    assert_eq!(*example_zk_proof_of_solvency_invoice::invoice_id(&payment), b"INV-001");
    assert_eq!(*example_zk_proof_of_solvency_invoice::invoice_circuit_id(&payment), b"circuit");
    // Only the payer has funded, so the tunnel is not yet active.
    assert!(!tunnel::is_active(example_zk_proof_of_solvency_invoice::invoice_tunnel(&payment)));

    example_zk_proof_of_solvency_invoice::destroy_invoice_payment_for_testing(payment);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun cancel_invoice_refunds_payer() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYEE,
        PK_A,
        PK_B,
        b"circuit",
        700,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    let refund = example_zk_proof_of_solvency_invoice::cancel_invoice<SUI>(
        &mut payment,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(refund.value(), 1000);
    assert_eq!(
        example_zk_proof_of_solvency_invoice::invoice_status(&payment),
        example_zk_proof_of_solvency_invoice::invoice_cancelled(),
    );

    refund.burn_for_testing();
    example_zk_proof_of_solvency_invoice::destroy_invoice_payment_for_testing(payment);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun proof_gated_payment_pays_payee() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let (registry, circuit_id) = registry_with_circuit(&mut scenario);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYEE,
        PK_A,
        PK_B,
        circuit_id,
        700,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    // Settles the invoice amount to the payee and the remainder to the payer once the
    // circuit gate passes. Proof and signatures are bypassed here (see the helper's doc).
    example_zk_proof_of_solvency_invoice::pay_invoice_no_proof_for_testing<SUI>(
        &mut payment,
        &registry,
        300,
        700,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(
        example_zk_proof_of_solvency_invoice::invoice_status(&payment),
        example_zk_proof_of_solvency_invoice::invoice_paid(),
    );

    scenario.next_tx(PAYEE);
    let to_payee = scenario.take_from_address<Coin<SUI>>(PAYEE);
    assert_eq!(to_payee.value(), 700);
    to_payee.burn_for_testing();

    scenario.next_tx(PAYER);
    let to_payer = scenario.take_from_address<Coin<SUI>>(PAYER);
    assert_eq!(to_payer.value(), 300);
    to_payer.burn_for_testing();

    destroy(registry);
    example_zk_proof_of_solvency_invoice::destroy_invoice_payment_for_testing(payment);
    clock.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_proof_of_solvency_invoice::EInsufficientBalance,
        location = sui_tunnel::example_zk_proof_of_solvency_invoice,
    ),
]
fun create_deposit_below_invoice_aborts() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let deposit = coin::mint_for_testing<SUI>(500, scenario.ctx());
    let payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYEE,
        PK_A,
        PK_B,
        b"circuit",
        700,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    let _payment = payment;
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_proof_of_solvency_invoice::EInvalidParties,
        location = sui_tunnel::example_zk_proof_of_solvency_invoice,
    ),
]
fun create_self_invoice_aborts() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYER,
        PK_A,
        PK_B,
        b"circuit",
        700,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    let _payment = payment;
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_proof_of_solvency_invoice::EInvalidParameter,
        location = sui_tunnel::example_zk_proof_of_solvency_invoice,
    ),
]
fun create_zero_invoice_amount_aborts() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYEE,
        PK_A,
        PK_B,
        b"circuit",
        0,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    let _payment = payment;
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_proof_of_solvency_invoice::EInvalidPublicKey,
        location = sui_tunnel::example_zk_proof_of_solvency_invoice,
    ),
]
fun create_empty_pk_aborts() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYEE,
        vector[],
        PK_B,
        b"circuit",
        700,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    let _payment = payment;
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_proof_of_solvency_invoice::EEmptyInput,
        location = sui_tunnel::example_zk_proof_of_solvency_invoice,
    ),
]
fun create_empty_circuit_id_aborts() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYEE,
        PK_A,
        PK_B,
        vector[],
        700,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    let _payment = payment;
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_proof_of_solvency_invoice::ECircuitNotRegistered,
        location = sui_tunnel::example_zk_proof_of_solvency_invoice,
    ),
]
fun pay_unregistered_circuit_aborts() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    // Empty registry: the invoice's circuit is not registered.
    let registry = zk_verifier::create_registry(PAYER, scenario.ctx());

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYEE,
        PK_A,
        PK_B,
        b"unregistered",
        700,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    example_zk_proof_of_solvency_invoice::pay_invoice_no_proof_for_testing<SUI>(
        &mut payment,
        &registry,
        300,
        700,
        &clock,
        scenario.ctx(),
    );

    let _registry = registry;
    let _payment = payment;
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_proof_of_solvency_invoice::EInvalidState,
        location = sui_tunnel::example_zk_proof_of_solvency_invoice,
    ),
]
fun pay_when_not_pending_aborts() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let (registry, circuit_id) = registry_with_circuit(&mut scenario);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYEE,
        PK_A,
        PK_B,
        circuit_id,
        700,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    example_zk_proof_of_solvency_invoice::set_status_for_testing(
        &mut payment,
        example_zk_proof_of_solvency_invoice::invoice_paid(),
    );

    example_zk_proof_of_solvency_invoice::pay_invoice_no_proof_for_testing<SUI>(
        &mut payment,
        &registry,
        300,
        700,
        &clock,
        scenario.ctx(),
    );

    let _registry = registry;
    let _payment = payment;
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_proof_of_solvency_invoice::EInvalidState,
        location = sui_tunnel::example_zk_proof_of_solvency_invoice,
    ),
]
fun cancel_after_settled_aborts() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYEE,
        PK_A,
        PK_B,
        b"circuit",
        700,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    example_zk_proof_of_solvency_invoice::set_status_for_testing(
        &mut payment,
        example_zk_proof_of_solvency_invoice::invoice_paid(),
    );

    let refund = example_zk_proof_of_solvency_invoice::cancel_invoice<SUI>(
        &mut payment,
        &clock,
        scenario.ctx(),
    );

    let _refund = refund;
    let _payment = payment;
    abort
}

// Drives the production pay_invoice_with_proof (not the no-proof helper) to cover its
// status gate: a settled invoice cannot be paid again.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_proof_of_solvency_invoice::EInvalidState,
        location = sui_tunnel::example_zk_proof_of_solvency_invoice,
    ),
]
fun pay_with_proof_when_not_pending_aborts() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let (registry, circuit_id) = registry_with_circuit(&mut scenario);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYEE,
        PK_A,
        PK_B,
        circuit_id,
        700,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    example_zk_proof_of_solvency_invoice::set_status_for_testing(
        &mut payment,
        example_zk_proof_of_solvency_invoice::invoice_paid(),
    );

    example_zk_proof_of_solvency_invoice::pay_invoice_with_proof<SUI>(
        &mut payment,
        &registry,
        b"proof",
        300,
        700,
        vector[],
        vector[],
        0,
        &clock,
        scenario.ctx(),
    );

    let _registry = registry;
    let _payment = payment;
    abort
}

// Drives the production pay_invoice_with_proof to cover its circuit-active gate, which the
// no-proof helper also exercises but only through the test-only path.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_zk_proof_of_solvency_invoice::ECircuitNotRegistered,
        location = sui_tunnel::example_zk_proof_of_solvency_invoice,
    ),
]
fun pay_with_proof_unregistered_circuit_aborts() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    // Empty registry: the invoice's circuit is not active, so the gate fires before
    // any proof verification.
    let registry = zk_verifier::create_registry(PAYER, scenario.ctx());

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYEE,
        PK_A,
        PK_B,
        b"unregistered",
        700,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    example_zk_proof_of_solvency_invoice::pay_invoice_with_proof<SUI>(
        &mut payment,
        &registry,
        b"proof",
        300,
        700,
        vector[],
        vector[],
        0,
        &clock,
        scenario.ctx(),
    );

    let _registry = registry;
    let _payment = payment;
    abort
}

// Regression for Z1: pay_invoice_with_proof now derives the proof's public inputs from
// the invoice itself (payer + invoice amount = 2 scalars = 64 bytes) instead of trusting a
// caller-supplied blob. Against a circuit registered for a single 32-byte input, the
// internally-built 64-byte inputs trip zk_verifier's length guard. Under the old spoofable
// parameter a caller could have passed a matching 32-byte blob and slipped past this gate.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::EInvalidPublicInputs,
        location = sui_tunnel::zk_verifier,
    ),
]
fun pay_with_proof_binds_public_inputs_to_invoice() {
    let mut scenario = test_scenario::begin(PAYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let mut registry = zk_verifier::create_registry(PAYER, scenario.ctx());
    let circuit = zk_verifier::create_circuit_with_pvk(
        b"solvency",
        zk_verifier::curve_bn254(),
        dummy_pvk(),
        1,
        b"schema",
    );
    zk_verifier::register_circuit(&mut registry, circuit, scenario.ctx());
    let circuit_id = zk_verifier::create_circuit_id(&b"solvency");

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut payment = example_zk_proof_of_solvency_invoice::create_invoice_payment<SUI>(
        PAYEE,
        PK_A,
        PK_B,
        circuit_id,
        700,
        b"INV-001",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    example_zk_proof_of_solvency_invoice::pay_invoice_with_proof<SUI>(
        &mut payment,
        &registry,
        b"proof",
        300,
        700,
        vector[],
        vector[],
        0,
        &clock,
        scenario.ctx(),
    );

    let _registry = registry;
    let _payment = payment;
    abort
}
