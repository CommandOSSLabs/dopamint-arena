#[test_only]
module sui_tunnel::quantum_poker_tests;

use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::quantum_poker;
use sui_tunnel::quantum_poker_referee;
use sui_tunnel::signature;
use sui_tunnel::tunnel;
use sui_tunnel::zk_verifier;

const PARTY_A: address = @0xAAAA;
const PARTY_B: address = @0xBBBB;

fun circuit_name(): vector<u8> { b"quantum_poker_v1" }

fun make_tunnel(
  party_a: address,
  party_b: address,
  clock: &clock::Clock,
  ctx: &mut TxContext,
): tunnel::Tunnel<SUI> {
  tunnel::create<SUI>(
    party_a,
    hash_11(),
    signature::ed25519(),
    party_b,
    hash_22(),
    signature::ed25519(),
    60000,
    0,
    clock,
    ctx,
  )
}

fun make_session<T>(
  tunnel_obj: &tunnel::Tunnel<T>,
  ctx: &mut TxContext,
): quantum_poker::PokerSession {
  quantum_poker::create_session(
    tunnel_obj,
    hash_22(),
    zk_verifier::create_circuit_id(&circuit_name()),
    hash_33(),
    ctx,
  )
}

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

  let pk_a =
    x"1111111111111111111111111111111111111111111111111111111111111111";
  let pk_b =
    x"2222222222222222222222222222222222222222222222222222222222222222";
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

  assert_eq!(
    quantum_poker::session_tunnel_id(&session),
    tunnel::id(&tunnel_obj),
  );
  assert_eq!(*quantum_poker::session_rules_hash(&session), hash_22());
  assert_eq!(*quantum_poker::session_circuit_id(&session), hash_11());
  assert_eq!(*quantum_poker::session_input_schema_hash(&session), hash_33());
  assert_eq!(
    quantum_poker::session_protocol_version(&session),
    quantum_poker::protocol_version(),
  );
  assert!(quantum_poker::session_five_of_a_kind_enabled(&session));
  assert_eq!(quantum_poker::session_created_by(&session), @0x0);

  quantum_poker::destroy_for_testing(session);
  tunnel::destroy_for_testing(tunnel_obj);
  clock.destroy_for_testing();
}

#[test]
fun confirm_session_params_by_counterparty_marks_agreed() {
  let mut scenario = test_scenario::begin(PARTY_A);
  let mut clock = clock::create_for_testing(scenario.ctx());
  clock.set_for_testing(1000);
  let tunnel_obj = make_tunnel(PARTY_A, PARTY_B, &clock, scenario.ctx());
  let mut session = make_session(&tunnel_obj, scenario.ctx());
  assert!(!quantum_poker::circuit_params_agreed(&session));

  scenario.next_tx(PARTY_B);
  quantum_poker::confirm_session_params(
    &mut session,
    &tunnel_obj,
    hash_22(),
    zk_verifier::create_circuit_id(&circuit_name()),
    hash_33(),
    scenario.ctx(),
  );
  assert!(quantum_poker::circuit_params_agreed(&session));

  quantum_poker::destroy_for_testing(session);
  tunnel::destroy_for_testing(tunnel_obj);
  clock.destroy_for_testing();
  scenario.end();
}

#[
  test,
  expected_failure(
    abort_code = sui_tunnel::quantum_poker::ENotCounterparty,
    location = sui_tunnel::quantum_poker,
  ),
]
fun confirm_session_params_rejects_creator() {
  let mut scenario = test_scenario::begin(PARTY_A);
  let mut clock = clock::create_for_testing(scenario.ctx());
  clock.set_for_testing(1000);
  let tunnel_obj = make_tunnel(PARTY_A, PARTY_B, &clock, scenario.ctx());
  let mut session = make_session(&tunnel_obj, scenario.ctx());

  // The creator cannot also be the counterparty that confirms.
  quantum_poker::confirm_session_params(
    &mut session,
    &tunnel_obj,
    hash_22(),
    zk_verifier::create_circuit_id(&circuit_name()),
    hash_33(),
    scenario.ctx(),
  );

  quantum_poker::destroy_for_testing(session);
  tunnel::destroy_for_testing(tunnel_obj);
  clock.destroy_for_testing();
  scenario.end();
}

#[
  test,
  expected_failure(
    abort_code = sui_tunnel::quantum_poker::EParamsMismatch,
    location = sui_tunnel::quantum_poker,
  ),
]
fun confirm_session_params_rejects_wrong_hash() {
  let mut scenario = test_scenario::begin(PARTY_A);
  let mut clock = clock::create_for_testing(scenario.ctx());
  clock.set_for_testing(1000);
  let tunnel_obj = make_tunnel(PARTY_A, PARTY_B, &clock, scenario.ctx());
  let mut session = make_session(&tunnel_obj, scenario.ctx());

  scenario.next_tx(PARTY_B);
  // Counterparty must re-commit to the exact stored rules hash.
  quantum_poker::confirm_session_params(
    &mut session,
    &tunnel_obj,
    hash_11(),
    zk_verifier::create_circuit_id(&circuit_name()),
    hash_33(),
    scenario.ctx(),
  );

  quantum_poker::destroy_for_testing(session);
  tunnel::destroy_for_testing(tunnel_obj);
  clock.destroy_for_testing();
  scenario.end();
}

#[
  test,
  expected_failure(
    abort_code = sui_tunnel::quantum_poker_referee::EParamsNotAgreed,
    location = sui_tunnel::quantum_poker_referee,
  ),
]
fun resolve_rejects_unagreed_params() {
  let mut ctx = sui::tx_context::dummy();
  let mut clock = clock::create_for_testing(&mut ctx);
  clock.set_for_testing(1000);
  let mut tunnel_obj = make_tunnel(@0x0, PARTY_B, &clock, &mut ctx);
  let session = make_session(&tunnel_obj, &mut ctx);
  let admin = zk_verifier::admin_cap_for_testing(&mut ctx);
  let registry = zk_verifier::create_trusted_registry(&admin, &mut ctx);

  let state_hash = *tunnel::state_hash(tunnel::state(&tunnel_obj));
  // No confirmation -> resolve aborts before any verification.
  quantum_poker_referee::resolve_with_proof(
    &session,
    &registry,
    &mut tunnel_obj,
    b"proof",
    state_hash,
    7,
    quantum_poker::winner_a(),
    0,
    0,
    hash_11(),
    &clock,
    &mut ctx,
  );

  destroy(admin);
  zk_verifier::destroy_registry_for_testing(registry);
  quantum_poker::destroy_for_testing(session);
  tunnel::destroy_for_testing(tunnel_obj);
  clock.destroy_for_testing();
}

#[
  test,
  expected_failure(
    abort_code = sui_tunnel::quantum_poker_referee::EUntrustedRegistry,
    location = sui_tunnel::quantum_poker_referee,
  ),
]
fun resolve_rejects_untrusted_registry() {
  let mut ctx = sui::tx_context::dummy();
  let mut clock = clock::create_for_testing(&mut ctx);
  clock.set_for_testing(1000);
  let mut tunnel_obj = make_tunnel(@0x0, PARTY_B, &clock, &mut ctx);
  let mut session = make_session(&tunnel_obj, &mut ctx);
  quantum_poker::mark_params_agreed_for_testing(&mut session);

  // Attacker-controlled registry: created without the trust anchor.
  let registry = zk_verifier::create_registry(@0x0, &mut ctx);
  assert!(!zk_verifier::is_trusted_registry(&registry));

  let state_hash = *tunnel::state_hash(tunnel::state(&tunnel_obj));
  quantum_poker_referee::resolve_with_proof(
    &session,
    &registry,
    &mut tunnel_obj,
    b"proof",
    state_hash,
    7,
    quantum_poker::winner_a(),
    0,
    0,
    hash_11(),
    &clock,
    &mut ctx,
  );

  zk_verifier::destroy_registry_for_testing(registry);
  quantum_poker::destroy_for_testing(session);
  tunnel::destroy_for_testing(tunnel_obj);
  clock.destroy_for_testing();
}

#[
  test,
  expected_failure(
    abort_code = sui_tunnel::quantum_poker_referee::ESchemaMismatch,
    location = sui_tunnel::quantum_poker_referee,
  ),
]
fun resolve_rejects_schema_mismatch() {
  let mut ctx = sui::tx_context::dummy();
  let mut clock = clock::create_for_testing(&mut ctx);
  clock.set_for_testing(1000);
  let mut tunnel_obj = make_tunnel(@0x0, PARTY_B, &clock, &mut ctx);
  let mut session = make_session(&tunnel_obj, &mut ctx);
  quantum_poker::mark_params_agreed_for_testing(&mut session);

  let admin = zk_verifier::admin_cap_for_testing(&mut ctx);
  let mut registry = zk_verifier::create_trusted_registry(&admin, &mut ctx);
  // Circuit committed schema differs from the session's agreed schema.
  let circuit = zk_verifier::create_circuit_with_pvk(
    circuit_name(),
    zk_verifier::curve_bn254(),
    dummy_pvk(),
    8,
    hash_11(),
  );
  zk_verifier::register_circuit(&mut registry, circuit, &ctx);

  let state_hash = *tunnel::state_hash(tunnel::state(&tunnel_obj));
  quantum_poker_referee::resolve_with_proof(
    &session,
    &registry,
    &mut tunnel_obj,
    b"proof",
    state_hash,
    7,
    quantum_poker::winner_a(),
    0,
    0,
    hash_11(),
    &clock,
    &mut ctx,
  );

  destroy(admin);
  zk_verifier::destroy_registry_for_testing(registry);
  quantum_poker::destroy_for_testing(session);
  tunnel::destroy_for_testing(tunnel_obj);
  clock.destroy_for_testing();
}

#[test]
fun trusted_agreed_session_satisfies_resolve_guards() {
  let mut ctx = sui::tx_context::dummy();
  let mut clock = clock::create_for_testing(&mut ctx);
  clock.set_for_testing(1000);
  let tunnel_obj = make_tunnel(@0x0, PARTY_B, &clock, &mut ctx);
  let mut session = make_session(&tunnel_obj, &mut ctx);
  quantum_poker::mark_params_agreed_for_testing(&mut session);

  let admin = zk_verifier::admin_cap_for_testing(&mut ctx);
  let mut registry = zk_verifier::create_trusted_registry(&admin, &mut ctx);
  let circuit = zk_verifier::create_circuit_with_pvk(
    circuit_name(),
    zk_verifier::curve_bn254(),
    dummy_pvk(),
    8,
    hash_33(),
  );
  zk_verifier::register_circuit(&mut registry, circuit, &ctx);

  // The legitimate setup clears every non-cryptographic resolve guard.
  assert!(zk_verifier::is_trusted_registry(&registry));
  assert!(quantum_poker::circuit_params_agreed(&session));
  let id = zk_verifier::create_circuit_id(&circuit_name());
  let registered = zk_verifier::get_circuit(&registry, &id);
  assert_eq!(
    *zk_verifier::circuit_input_schema_hash(registered),
    *quantum_poker::session_input_schema_hash(&session),
  );

  destroy(admin);
  zk_verifier::destroy_registry_for_testing(registry);
  quantum_poker::destroy_for_testing(session);
  tunnel::destroy_for_testing(tunnel_obj);
  clock.destroy_for_testing();
}

fun dummy_pvk(): sui::groth16::PreparedVerifyingKey {
  sui::groth16::pvk_from_bytes(
    b"vk_gamma_abc",
    b"alpha_beta",
    b"gamma_neg",
    b"delta_neg",
  )
}
