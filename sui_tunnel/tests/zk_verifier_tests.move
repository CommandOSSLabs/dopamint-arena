#[test_only]
module sui_tunnel::zk_verifier_tests;

use std::unit_test::assert_eq;
use sui::groth16;
use sui::test_scenario;
use sui_tunnel::zk_verifier;

// ============================================
// TEST HELPERS
// ============================================

const OWNER: address = @0xA11CE;
const NOT_OWNER: address = @0xB0B;

/// Builds a `PreparedVerifyingKey` from arbitrary (non-cryptographic) bytes.
/// `groth16::pvk_from_bytes` is a pure constructor with no native validation,
/// so this lets us build `Circuit` values for registry/validation tests
/// without needing a real Arkworks verifying key.
fun dummy_pvk(): groth16::PreparedVerifyingKey {
    groth16::pvk_from_bytes(b"vk_gamma_abc", b"alpha_beta", b"gamma_neg", b"delta_neg")
}

/// Builds a `Circuit` via the pvk path (avoids native VK preparation) with the
/// given name / curve / number of public inputs.
fun make_circuit(name: vector<u8>, curve: u8, num_inputs: u64): zk_verifier::Circuit {
    zk_verifier::create_circuit_with_pvk(name, curve, dummy_pvk(), num_inputs, b"schema")
}

#[test]
fun curve_constants() {
    assert_eq!(zk_verifier::curve_bls12381(), 0);
    assert_eq!(zk_verifier::curve_bn254(), 1);
}

#[test]
fun is_valid_curve() {
    assert!(zk_verifier::is_valid_curve(zk_verifier::curve_bls12381()));
    assert!(zk_verifier::is_valid_curve(zk_verifier::curve_bn254()));
    assert!(!zk_verifier::is_valid_curve(2));
    assert!(!zk_verifier::is_valid_curve(255));
}

#[test]
fun create_circuit_id() {
    let id1 = zk_verifier::create_circuit_id(&b"payment_circuit");
    let id2 = zk_verifier::create_circuit_id(&b"payment_circuit");
    let id3 = zk_verifier::create_circuit_id(&b"game_circuit");
    assert_eq!(id1, id2);
    assert!(id1 != id3);
    assert_eq!(id1.length(), 32);
}

#[test]
fun u64_to_scalar() {
    // Source encodes little-endian: byte 0 is the least-significant byte.
    let scalar0 = zk_verifier::u64_to_scalar(0);
    assert_eq!(scalar0.length(), zk_verifier::scalar_size());
    assert_eq!(scalar0, x"0000000000000000000000000000000000000000000000000000000000000000");

    let scalar1 = zk_verifier::u64_to_scalar(1);
    assert_eq!(scalar1.length(), 32);
    // LSB first: 0x01 in byte 0, everything else zero.
    assert_eq!(scalar1, x"0100000000000000000000000000000000000000000000000000000000000000");

    let scalar256 = zk_verifier::u64_to_scalar(256);
    assert_eq!(*scalar256.borrow(0), 0);
    assert_eq!(*scalar256.borrow(1), 1);

    // Exercise every byte of the u64 with a distinct value, then assert the
    // exact little-endian layout plus the 24 zero pad bytes (indices 8..31).
    let v: u64 = 0x0807060504030201;
    let scalar = zk_verifier::u64_to_scalar(v);
    assert_eq!(*scalar.borrow(0), 0x01);
    assert_eq!(*scalar.borrow(1), 0x02);
    assert_eq!(*scalar.borrow(2), 0x03);
    assert_eq!(*scalar.borrow(3), 0x04);
    assert_eq!(*scalar.borrow(4), 0x05);
    assert_eq!(*scalar.borrow(5), 0x06);
    assert_eq!(*scalar.borrow(6), 0x07);
    assert_eq!(*scalar.borrow(7), 0x08);
    let mut i = 8;
    while (i < 32) {
        assert_eq!(*scalar.borrow(i), 0);
        i = i + 1;
    };

    // u64::MAX fills the low 8 bytes with 0xFF, pad stays zero.
    let scalar_max = zk_verifier::u64_to_scalar(0xFFFFFFFFFFFFFFFF);
    assert_eq!(scalar_max, x"ffffffffffffffff000000000000000000000000000000000000000000000000");
}

#[test]
fun u256_to_scalar() {
    let scalar = zk_verifier::u256_to_scalar(0);
    assert_eq!(scalar.length(), 32);
    assert_eq!(scalar, x"0000000000000000000000000000000000000000000000000000000000000000");

    let scalar1 = zk_verifier::u256_to_scalar(1);
    assert_eq!(*scalar1.borrow(0), 1);
    let mut i = 1;
    while (i < 32) {
        assert_eq!(*scalar1.borrow(i), 0);
        i = i + 1;
    };

    // Little-endian: 0x0102 => byte0 = 0x02 (LSB), byte1 = 0x01.
    let scalar_le = zk_verifier::u256_to_scalar(0x0102);
    assert_eq!(*scalar_le.borrow(0), 0x02);
    assert_eq!(*scalar_le.borrow(1), 0x01);
    assert_eq!(*scalar_le.borrow(2), 0x00);

    // The most-significant byte lands at index 31 (full-width value).
    let top: u256 = 1u256 << 248; // 0x01 in the highest byte
    let scalar_top = zk_verifier::u256_to_scalar(top);
    assert_eq!(*scalar_top.borrow(31), 0x01);
    assert_eq!(*scalar_top.borrow(0), 0x00);

    // u256::MAX is all 0xFF.
    let scalar_max = zk_verifier::u256_to_scalar(
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF,
    );
    assert_eq!(scalar_max, x"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
}

#[test]
fun address_to_scalar() {
    // Sui addresses are exactly 32 bytes; `to_bytes()` is big-endian.
    let scalar = zk_verifier::address_to_scalar(@0x1234);
    assert_eq!(scalar.length(), 32);
    // @0x1234 is left-padded with zeros; the value lives in the last 2 bytes.
    assert_eq!(scalar, x"0000000000000000000000000000000000000000000000000000000000001234");

    let zero = zk_verifier::address_to_scalar(@0x0);
    assert_eq!(zero, x"0000000000000000000000000000000000000000000000000000000000000000");
}

#[test]
fun concat_scalars() {
    let s1 = zk_verifier::u64_to_scalar(100);
    let s2 = zk_verifier::u64_to_scalar(200);
    let s3 = zk_verifier::u64_to_scalar(300);
    let combined = zk_verifier::concat_scalars(vector[s1, s2, s3]);
    assert_eq!(combined.length(), 96);

    // The result is the in-order byte concatenation of each scalar: assert the
    // first byte of each 32-byte window matches the LSB of the source value.
    assert_eq!(*combined.borrow(0), 100); // s1 LSB
    assert_eq!(*combined.borrow(32), 200); // s2 LSB
    assert_eq!(*combined.borrow(64), 44); // s3 = 300 -> 300 & 0xFF == 44
    assert_eq!(*combined.borrow(65), 1); // s3 byte 1 -> 300 >> 8 == 1
}

#[test]
fun concat_scalars_empty() {
    // Zero scalars is allowed (0 <= MAX) and yields an empty vector.
    let combined = zk_verifier::concat_scalars(vector<vector<u8>>[]);
    assert_eq!(combined.length(), 0);
}

#[test]
fun concat_scalars_max_count() {
    // Exactly MAX_PUBLIC_INPUTS (8) scalars must succeed (boundary).
    let mut scalars = vector<vector<u8>>[];
    let mut i = 0;
    while (i < zk_verifier::max_public_inputs()) {
        scalars.push_back(zk_verifier::u64_to_scalar(i));
        i = i + 1;
    };
    let combined = zk_verifier::concat_scalars(scalars);
    assert_eq!(combined.length(), 8 * 32);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::EInvalidPublicInputs,
        location = sui_tunnel::zk_verifier,
    ),
]
fun concat_scalars_wrong_length_aborts() {
    // A scalar that is not exactly 32 bytes must abort (invalid_public_inputs).
    let bad = b"only_31_bytes_long_xxxxxxxxxxxx"; // length 31
    assert_eq!(bad.length(), 31);
    let _ = zk_verifier::concat_scalars(vector[bad]);
}

#[test]
fun hash_to_scalar() {
    let data = b"some data to hash";
    let scalar = zk_verifier::hash_to_scalar(&data);
    assert_eq!(scalar.length(), 32);
    let scalar2 = zk_verifier::hash_to_scalar(&data);
    assert_eq!(scalar, scalar2);
}

#[test]
fun create_registry() {
    let mut ctx = sui::tx_context::dummy();
    let registry = zk_verifier::create_registry(@0x1234, &mut ctx);
    assert_eq!(zk_verifier::registry_owner(&registry), @0x1234);
    assert_eq!(zk_verifier::registry_circuit_count(&registry), 0);
    zk_verifier::destroy_registry_for_testing(registry);
}

#[test]
fun create_zk_state_proof() {
    let proof = zk_verifier::create_zk_state_proof(
        b"circuit_id",
        b"public_inputs",
        b"proof_bytes",
        42,
    );
    assert_eq!(*zk_verifier::zk_proof_circuit_id(&proof), b"circuit_id");
    assert_eq!(*zk_verifier::zk_proof_public_inputs(&proof), b"public_inputs");
    assert_eq!(*zk_verifier::zk_proof_proof(&proof), b"proof_bytes");
    assert_eq!(zk_verifier::zk_proof_state_version(&proof), 42);
}

#[test]
fun create_verification_result() {
    let inputs = b"test inputs";
    let result = zk_verifier::create_verification_result(true, b"circuit_id", &inputs, 1234567890);
    assert!(zk_verifier::result_valid(&result));
    assert_eq!(*zk_verifier::result_circuit_id(&result), b"circuit_id");
    assert_eq!(zk_verifier::result_timestamp(&result), 1234567890);
    assert_eq!(zk_verifier::result_inputs_hash(&result).length(), 32);
}

#[test]
fun max_public_inputs() {
    assert_eq!(zk_verifier::max_public_inputs(), 8);
    assert_eq!(zk_verifier::scalar_size(), 32);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::EInvalidPublicInputs,
        location = sui_tunnel::zk_verifier,
    ),
]
fun concat_scalars_too_many() {
    let mut scalars = vector<vector<u8>>[];
    let mut i = 0;
    while (i < 9) {
        scalars.push_back(zk_verifier::u64_to_scalar(i));
        i = i + 1;
    };
    let _ = zk_verifier::concat_scalars(scalars);
}

// ============================================
// CURVE FUNCTIONS
// ============================================

#[test]
fun get_curve_valid() {
    // Both supported curves return without aborting; equality of returned
    // Curve values is asserted by comparing against the groth16 constructors.
    assert_eq!(zk_verifier::get_curve(zk_verifier::curve_bls12381()), groth16::bls12381());
    assert_eq!(zk_verifier::get_curve(zk_verifier::curve_bn254()), groth16::bn254());
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::EInvalidParameter,
        location = sui_tunnel::zk_verifier,
    ),
]
fun get_curve_invalid_aborts() {
    // Unknown curve id -> EInvalidParameter.
    let _ = zk_verifier::get_curve(7);
}

// ============================================
// CIRCUIT CREATION (create_circuit_with_pvk)
// ============================================

#[test]
fun create_circuit_with_pvk_success() {
    let circuit = make_circuit(b"payment", zk_verifier::curve_bn254(), 2);

    // id is the blake2b256 of the name.
    assert_eq!(*zk_verifier::circuit_id(&circuit), zk_verifier::create_circuit_id(&b"payment"));
    assert_eq!(*zk_verifier::circuit_name(&circuit), b"payment");
    assert_eq!(zk_verifier::circuit_curve(&circuit), zk_verifier::curve_bn254());
    assert_eq!(zk_verifier::circuit_num_inputs(&circuit), 2);
    assert_eq!(*zk_verifier::circuit_input_schema_hash(&circuit), b"schema");
    // Newly created circuits are active by default.
    assert!(zk_verifier::circuit_is_active(&circuit));
}

#[test]
fun create_circuit_with_pvk_max_inputs_boundary() {
    // num_public_inputs == MAX_PUBLIC_INPUTS (8) is allowed (<=).
    let circuit = make_circuit(
        b"max",
        zk_verifier::curve_bls12381(),
        zk_verifier::max_public_inputs(),
    );
    assert_eq!(zk_verifier::circuit_num_inputs(&circuit), 8);
}

#[test]
fun create_circuit_with_pvk_zero_inputs() {
    // Zero public inputs is valid (0 <= 8).
    let circuit = make_circuit(b"zero", zk_verifier::curve_bn254(), 0);
    assert_eq!(zk_verifier::circuit_num_inputs(&circuit), 0);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::EInvalidParameter,
        location = sui_tunnel::zk_verifier,
    ),
]
fun create_circuit_with_pvk_bad_curve_aborts() {
    // Invalid curve -> invalid_parameter (2).
    let _ = make_circuit(b"bad_curve", 9, 2);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::EInvalidPublicInputs,
        location = sui_tunnel::zk_verifier,
    ),
]
fun create_circuit_with_pvk_too_many_inputs_aborts() {
    // num_public_inputs > MAX (8) -> invalid_public_inputs (602).
    let _ = make_circuit(b"too_many", zk_verifier::curve_bn254(), 9);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::EEmptyInput,
        location = sui_tunnel::zk_verifier,
    ),
]
fun create_circuit_with_pvk_empty_name_aborts() {
    // Empty name -> EEmptyInput.
    let _ = make_circuit(b"", zk_verifier::curve_bn254(), 2);
}

// ============================================
// REGISTRY: register / duplicate / count
// ============================================

#[test]
fun register_circuit_success() {
    let mut ctx = sui::tx_context::dummy();
    // dummy() sender is @0x0; create the registry owned by @0x0 so ctx.sender()
    // matches and authorization passes.
    let owner = ctx.sender();
    let mut registry = zk_verifier::create_registry(owner, &mut ctx);

    let c1 = make_circuit(b"alpha", zk_verifier::curve_bn254(), 1);
    zk_verifier::register_circuit(&mut registry, c1, &ctx);
    assert_eq!(zk_verifier::registry_circuit_count(&registry), 1);

    let c2 = make_circuit(b"beta", zk_verifier::curve_bls12381(), 2);
    zk_verifier::register_circuit(&mut registry, c2, &ctx);
    assert_eq!(zk_verifier::registry_circuit_count(&registry), 2);

    // get_circuit returns the registered fields.
    let id_alpha = zk_verifier::create_circuit_id(&b"alpha");
    let fetched = zk_verifier::get_circuit(&registry, &id_alpha);
    assert_eq!(*zk_verifier::circuit_name(fetched), b"alpha");
    assert_eq!(zk_verifier::circuit_num_inputs(fetched), 1);
    assert!(zk_verifier::circuit_is_active(fetched));
    assert!(zk_verifier::is_circuit_active(&registry, &id_alpha));

    zk_verifier::destroy_registry_for_testing(registry);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::ECircuitAlreadyRegistered,
        location = sui_tunnel::zk_verifier,
    ),
]
fun register_circuit_duplicate_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let owner = ctx.sender();
    let mut registry = zk_verifier::create_registry(owner, &mut ctx);

    // Two circuits with the same name share an id -> duplicate registration
    // aborts with circuit_already_registered (605).
    let c1 = make_circuit(b"dup", zk_verifier::curve_bn254(), 1);
    zk_verifier::register_circuit(&mut registry, c1, &ctx);

    let c2 = make_circuit(b"dup", zk_verifier::curve_bls12381(), 2);
    zk_verifier::register_circuit(&mut registry, c2, &ctx);

    zk_verifier::destroy_registry_for_testing(registry);
}

// ============================================
// REGISTRY: authorization (owner vs non-owner)
// ============================================

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::ENotAuthorized,
        location = sui_tunnel::zk_verifier,
    ),
]
fun register_circuit_unauthorized_aborts() {
    let mut scenario = test_scenario::begin(OWNER);
    let mut registry = zk_verifier::create_registry(OWNER, scenario.ctx());

    // Switch to a different sender; register must abort not_authorized (0).
    scenario.next_tx(NOT_OWNER);
    let c = make_circuit(b"x", zk_verifier::curve_bn254(), 1);
    zk_verifier::register_circuit(&mut registry, c, scenario.ctx());

    zk_verifier::destroy_registry_for_testing(registry);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::ENotAuthorized,
        location = sui_tunnel::zk_verifier,
    ),
]
fun deactivate_circuit_unauthorized_aborts() {
    let mut scenario = test_scenario::begin(OWNER);
    let mut registry = zk_verifier::create_registry(OWNER, scenario.ctx());
    let c = make_circuit(b"x", zk_verifier::curve_bn254(), 1);
    zk_verifier::register_circuit(&mut registry, c, scenario.ctx());

    scenario.next_tx(NOT_OWNER);
    let id = zk_verifier::create_circuit_id(&b"x");
    zk_verifier::deactivate_circuit(&mut registry, &id, scenario.ctx());

    zk_verifier::destroy_registry_for_testing(registry);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::ENotAuthorized,
        location = sui_tunnel::zk_verifier,
    ),
]
fun reactivate_circuit_unauthorized_aborts() {
    let mut scenario = test_scenario::begin(OWNER);
    let mut registry = zk_verifier::create_registry(OWNER, scenario.ctx());
    let c = make_circuit(b"x", zk_verifier::curve_bn254(), 1);
    zk_verifier::register_circuit(&mut registry, c, scenario.ctx());
    let id = zk_verifier::create_circuit_id(&b"x");
    zk_verifier::deactivate_circuit(&mut registry, &id, scenario.ctx());

    scenario.next_tx(NOT_OWNER);
    zk_verifier::reactivate_circuit(&mut registry, &id, scenario.ctx());

    zk_verifier::destroy_registry_for_testing(registry);
    scenario.end();
}

// ============================================
// REGISTRY: deactivate / reactivate lifecycle
// ============================================

#[test]
fun deactivate_then_reactivate() {
    let mut scenario = test_scenario::begin(OWNER);
    let mut registry = zk_verifier::create_registry(OWNER, scenario.ctx());
    let c = make_circuit(b"toggle", zk_verifier::curve_bn254(), 1);
    zk_verifier::register_circuit(&mut registry, c, scenario.ctx());
    let id = zk_verifier::create_circuit_id(&b"toggle");

    // Initially active.
    assert!(zk_verifier::is_circuit_active(&registry, &id));

    // Deactivate flips active -> false.
    zk_verifier::deactivate_circuit(&mut registry, &id, scenario.ctx());
    assert!(!zk_verifier::is_circuit_active(&registry, &id));
    assert!(!zk_verifier::circuit_is_active(zk_verifier::get_circuit(&registry, &id)));

    // Reactivate flips active -> true again.
    zk_verifier::reactivate_circuit(&mut registry, &id, scenario.ctx());
    assert!(zk_verifier::is_circuit_active(&registry, &id));
    assert!(zk_verifier::circuit_is_active(zk_verifier::get_circuit(&registry, &id)));

    zk_verifier::destroy_registry_for_testing(registry);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::ECircuitNotRegistered,
        location = sui_tunnel::zk_verifier,
    ),
]
fun deactivate_missing_circuit_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let owner = ctx.sender();
    let mut registry = zk_verifier::create_registry(owner, &mut ctx);

    // No circuit with this id -> circuit_not_registered (603).
    let missing = zk_verifier::create_circuit_id(&b"does_not_exist");
    zk_verifier::deactivate_circuit(&mut registry, &missing, &ctx);

    zk_verifier::destroy_registry_for_testing(registry);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::ECircuitNotRegistered,
        location = sui_tunnel::zk_verifier,
    ),
]
fun reactivate_missing_circuit_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let owner = ctx.sender();
    let mut registry = zk_verifier::create_registry(owner, &mut ctx);

    let missing = zk_verifier::create_circuit_id(&b"does_not_exist");
    zk_verifier::reactivate_circuit(&mut registry, &missing, &ctx);

    zk_verifier::destroy_registry_for_testing(registry);
}

// ============================================
// REGISTRY: get_circuit / is_circuit_active on missing id
// ============================================

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::ECircuitNotRegistered,
        location = sui_tunnel::zk_verifier,
    ),
]
fun get_circuit_missing_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let owner = ctx.sender();
    let registry = zk_verifier::create_registry(owner, &mut ctx);

    // get_circuit on a missing id aborts circuit_not_registered (603).
    let missing = zk_verifier::create_circuit_id(&b"nope");
    let _ = zk_verifier::get_circuit(&registry, &missing);

    zk_verifier::destroy_registry_for_testing(registry);
}

#[test]
fun is_circuit_active_missing_returns_false() {
    let mut ctx = sui::tx_context::dummy();
    let owner = ctx.sender();
    let registry = zk_verifier::create_registry(owner, &mut ctx);

    // Unlike get_circuit, is_circuit_active returns false (no abort) when absent.
    let missing = zk_verifier::create_circuit_id(&b"nope");
    assert!(!zk_verifier::is_circuit_active(&registry, &missing));

    zk_verifier::destroy_registry_for_testing(registry);
}

// ============================================
// REGISTRY: version helpers
// ============================================

#[test]
fun registry_version_is_current() {
    let mut ctx = sui::tx_context::dummy();
    let registry = zk_verifier::create_registry(@0x1234, &mut ctx);
    assert_eq!(zk_verifier::registry_version(&registry), zk_verifier::current_version());
    assert_eq!(zk_verifier::current_version(), 1);
    // Must not abort at the current version.
    zk_verifier::assert_current_version(&registry);
    zk_verifier::destroy_registry_for_testing(registry);
}

// ============================================
// VERIFICATION: public-input length validation
// ============================================

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::EInvalidPublicInputs,
        location = sui_tunnel::zk_verifier,
    ),
]
fun verify_circuit_proof_wrong_input_length_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let owner = ctx.sender();
    let mut registry = zk_verifier::create_registry(owner, &mut ctx);

    // Circuit expects 2 public inputs -> 64 bytes. Provide 32 bytes (one
    // scalar) so the length guard trips before any native verification runs:
    // invalid_public_inputs (602).
    let c = make_circuit(b"len2", zk_verifier::curve_bn254(), 2);
    zk_verifier::register_circuit(&mut registry, c, &ctx);
    let id = zk_verifier::create_circuit_id(&b"len2");

    let wrong_inputs = zk_verifier::u64_to_scalar(1); // 32 bytes, expected 64
    let proof = b"dummy_proof_bytes";
    let _ = zk_verifier::verify_circuit_proof(&registry, &id, &wrong_inputs, &proof);

    zk_verifier::destroy_registry_for_testing(registry);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::ECircuitNotRegistered,
        location = sui_tunnel::zk_verifier,
    ),
]
fun verify_circuit_proof_inactive_circuit_aborts() {
    let mut scenario = test_scenario::begin(OWNER);
    let mut registry = zk_verifier::create_registry(OWNER, scenario.ctx());

    // Register then deactivate. verify_circuit_proof asserts circuit.active
    // (circuit_not_registered == 603) before the input-length check, so a
    // correct-length input still aborts 603 on an inactive circuit.
    let c = make_circuit(b"inactive", zk_verifier::curve_bn254(), 1);
    zk_verifier::register_circuit(&mut registry, c, scenario.ctx());
    let id = zk_verifier::create_circuit_id(&b"inactive");
    zk_verifier::deactivate_circuit(&mut registry, &id, scenario.ctx());

    let inputs = zk_verifier::u64_to_scalar(1); // 32 bytes == 1 * SCALAR_SIZE
    let proof = b"dummy_proof_bytes";
    let _ = zk_verifier::verify_circuit_proof(&registry, &id, &inputs, &proof);

    zk_verifier::destroy_registry_for_testing(registry);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::ECircuitNotRegistered,
        location = sui_tunnel::zk_verifier,
    ),
]
fun verify_circuit_proof_unregistered_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let owner = ctx.sender();
    let registry = zk_verifier::create_registry(owner, &mut ctx);

    // No circuit registered -> get_circuit aborts circuit_not_registered (603).
    let id = zk_verifier::create_circuit_id(&b"ghost");
    let inputs = zk_verifier::u64_to_scalar(1);
    let proof = b"dummy_proof_bytes";
    let _ = zk_verifier::verify_circuit_proof(&registry, &id, &inputs, &proof);

    zk_verifier::destroy_registry_for_testing(registry);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::EInvalidPublicInputs,
        location = sui_tunnel::zk_verifier,
    ),
]
fun verify_with_circuit_wrong_input_length_aborts() {
    // verify_with_circuit has parity validation: 1 input expects 32 bytes,
    // give 64 -> invalid_public_inputs (602), before any native call.
    let circuit = make_circuit(b"direct", zk_verifier::curve_bn254(), 1);
    let mut wrong = zk_verifier::u64_to_scalar(1);
    wrong.append(zk_verifier::u64_to_scalar(2)); // 64 bytes, expected 32
    let proof = b"dummy_proof_bytes";
    let _ = zk_verifier::verify_with_circuit(&circuit, &wrong, &proof);
}

// ============================================
// ZK STATE PROOF: length validation via verify_zk_state_proof
// ============================================

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::zk_verifier::EInvalidPublicInputs,
        location = sui_tunnel::zk_verifier,
    ),
]
fun verify_zk_state_proof_wrong_length_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let owner = ctx.sender();
    let mut registry = zk_verifier::create_registry(owner, &mut ctx);

    let c = make_circuit(b"state", zk_verifier::curve_bn254(), 2);
    zk_verifier::register_circuit(&mut registry, c, &ctx);
    let id = zk_verifier::create_circuit_id(&b"state");

    // Wrap a wrong-length public-input blob and route through the state-proof
    // path: still hits the 602 length guard inside verify_circuit_proof.
    let state_proof = zk_verifier::create_zk_state_proof(
        id,
        zk_verifier::u64_to_scalar(1), // 32 bytes, circuit expects 64
        b"dummy_proof_bytes",
        7,
    );
    assert_eq!(zk_verifier::state_proof_version(&state_proof), 7);
    let _ = zk_verifier::verify_zk_state_proof(&registry, &state_proof);

    zk_verifier::destroy_registry_for_testing(registry);
}
