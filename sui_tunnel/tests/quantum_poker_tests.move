#[test_only]
module sui_tunnel::quantum_poker_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::sui::SUI;
use sui_tunnel::quantum_poker;
use sui_tunnel::quantum_poker_referee;
use sui_tunnel::signature;
use sui_tunnel::tunnel;

fun hash_ff(): vector<u8> {
    x"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
}

fun hash_11(): vector<u8> {
    x"1111111111111111111111111111111111111111111111111111111111111111"
}

fun hash_22(): vector<u8> {
    x"2222222222222222222222222222222222222222222222222222222222222222"
}

fun hash_33(): vector<u8> {
    x"3333333333333333333333333333333333333333333333333333333333333333"
}

#[test]
fun field_safe_scalar_masks_most_significant_little_endian_byte() {
    let scalar = quantum_poker_referee::field_safe_scalar(hash_ff());
    assert_eq!(scalar.length(), 32);
    assert_eq!(*scalar.borrow(0), 0xff);
    assert_eq!(*scalar.borrow(31), 0x1f);
}

#[test]
fun result_public_inputs_are_eight_scalars() {
    let inputs = quantum_poker_referee::build_public_inputs(
        hash_ff(),
        hash_ff(),
        hash_ff(),
        7,
        quantum_poker::winner_a(),
        1200,
        800,
        hash_ff(),
    );

    assert_eq!(inputs.length(), 8 * 32);
    assert_eq!(*inputs.borrow(31), 0x1f);
    assert_eq!(*inputs.borrow(63), 0x1f);
    assert_eq!(*inputs.borrow(95), 0x1f);
    assert_eq!(*inputs.borrow(96), 7);
    assert_eq!(*inputs.borrow(128), quantum_poker::winner_a() as u8);
    assert_eq!(*inputs.borrow(160), 0xb0);
    assert_eq!(*inputs.borrow(161), 0x04);
    assert_eq!(*inputs.borrow(192), 0x20);
    assert_eq!(*inputs.borrow(193), 0x03);
    assert_eq!(*inputs.borrow(255), 0x1f);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::quantum_poker_referee::EInvalidWinner,
        location = sui_tunnel::quantum_poker_referee,
    ),
]
fun result_public_inputs_reject_bad_winner() {
    quantum_poker_referee::build_public_inputs(
        hash_11(),
        hash_11(),
        hash_11(),
        0,
        3,
        1000,
        1000,
        hash_11(),
    );
}

#[test]
fun create_session_binds_to_tunnel_and_circuit_schema() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";
    let tunnel_obj = tunnel::create<SUI>(
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

    let session = quantum_poker::create_session(
        &tunnel_obj,
        hash_22(),
        hash_11(),
        hash_33(),
        &mut ctx,
    );

    assert_eq!(quantum_poker::session_tunnel_id(&session), tunnel::id(&tunnel_obj));
    assert_eq!(*quantum_poker::session_rules_hash(&session), hash_22());
    assert_eq!(*quantum_poker::session_circuit_id(&session), hash_11());
    assert_eq!(*quantum_poker::session_input_schema_hash(&session), hash_33());
    assert_eq!(quantum_poker::session_protocol_version(&session), quantum_poker::protocol_version());
    assert!(quantum_poker::session_five_of_a_kind_enabled(&session));
    assert_eq!(quantum_poker::session_created_by(&session), @0x0);

    quantum_poker::destroy_for_testing(session);
    tunnel::destroy_for_testing(tunnel_obj);
    clock.destroy_for_testing();
}
