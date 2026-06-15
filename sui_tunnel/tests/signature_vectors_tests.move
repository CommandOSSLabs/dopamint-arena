// Real-signature verification tests: off-chain signatures produced by the TS SDK
// (deterministic fixed keys) over the canonical wire-format messages must be
// accepted by the on-chain `signature::verify`. This is what lets SDK-signed
// off-chain state updates / settlements / HTLC locks be settled and adjudicated
// on-chain, and it gives the signature-gated flows positive real-vector coverage.
//
// Fixtures are generated (not hand-written): sui-tunnel-ts/src/core/sig-vectors.gen.ts
// emits sui_tunnel::sig_vectors. Canonical inputs match wire_format_tests.move:
//   tunnel_id=@0xab  state_hash/payment_hash=0x01..0x20
//   state_update: nonce=42 ts=1234567890 balA=1000 balB=2000
//   settlement:   balA=1000 balB=2000 final_nonce=43 ts=1234567890
//   htlc_lock:    amount=500 sender=@0xaa receiver=@0xbb expiry=9999999
#[test_only]
module sui_tunnel::signature_vectors_tests;

use sui_tunnel::sig_vectors;
use sui_tunnel::signature;
use sui_tunnel::tunnel;

const STATE_HASH: vector<u8> = x"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

fun state_update_msg(): vector<u8> {
    let id = sui::object::id_from_address(@0xab);
    let data = tunnel::create_state_update_data_for_testing(
        id,
        STATE_HASH,
        42,
        1234567890,
        1000,
        2000,
    );
    tunnel::serialize_state_update(&data)
}

fun settlement_msg(): vector<u8> {
    let id = sui::object::id_from_address(@0xab);
    let data = tunnel::create_settlement_data_for_testing(id, 1000, 2000, 43, 1234567890);
    tunnel::serialize_settlement(&data)
}

fun settlement_v2_msg(): vector<u8> {
    let id = sui::object::id_from_address(@0xab);
    let data = tunnel::create_settlement_with_root_data_for_testing(
        id,
        1000,
        2000,
        43,
        1234567890,
        STATE_HASH,
    );
    tunnel::serialize_settlement_with_root(&data)
}

fun htlc_lock_msg(): vector<u8> {
    let id = sui::object::id_from_address(@0xab);
    let data = tunnel::create_htlc_lock_data_for_testing(
        id,
        STATE_HASH,
        500,
        @0xaa,
        @0xbb,
        9999999,
    );
    tunnel::serialize_htlc_lock(&data)
}

// ============================================
// ED25519 — both parties, every signed message
// ============================================

#[test]
fun ed25519_state_update_dual_sig_verifies() {
    let msg = state_update_msg();
    assert!(
        signature::verify(
            signature::ed25519(),
            &sig_vectors::ed25519_pk_a(),
            &msg,
            &sig_vectors::ed25519_state_update_sig_a(),
        ),
    );
    assert!(
        signature::verify(
            signature::ed25519(),
            &sig_vectors::ed25519_pk_b(),
            &msg,
            &sig_vectors::ed25519_state_update_sig_b(),
        ),
    );
}

#[test]
fun ed25519_settlement_dual_sig_verifies() {
    let msg = settlement_msg();
    assert!(
        signature::verify(
            signature::ed25519(),
            &sig_vectors::ed25519_pk_a(),
            &msg,
            &sig_vectors::ed25519_settlement_sig_a(),
        ),
    );
    assert!(
        signature::verify(
            signature::ed25519(),
            &sig_vectors::ed25519_pk_b(),
            &msg,
            &sig_vectors::ed25519_settlement_sig_b(),
        ),
    );
}

#[test]
fun ed25519_settlement_v2_dual_sig_verifies() {
    let msg = settlement_v2_msg();
    assert!(
        signature::verify(
            signature::ed25519(),
            &sig_vectors::ed25519_pk_a(),
            &msg,
            &sig_vectors::ed25519_settlement_v2_sig_a(),
        ),
    );
    assert!(
        signature::verify(
            signature::ed25519(),
            &sig_vectors::ed25519_pk_b(),
            &msg,
            &sig_vectors::ed25519_settlement_v2_sig_b(),
        ),
    );
}

#[test]
fun ed25519_htlc_lock_dual_sig_verifies() {
    let msg = htlc_lock_msg();
    assert!(
        signature::verify(
            signature::ed25519(),
            &sig_vectors::ed25519_pk_a(),
            &msg,
            &sig_vectors::ed25519_htlc_lock_sig_a(),
        ),
    );
    assert!(
        signature::verify(
            signature::ed25519(),
            &sig_vectors::ed25519_pk_b(),
            &msg,
            &sig_vectors::ed25519_htlc_lock_sig_b(),
        ),
    );
}

// ============================================
// SECP256K1 — Sui hashes the message with SHA256 internally
// ============================================

#[test]
fun secp256k1_state_update_sig_verifies() {
    let msg = state_update_msg();
    assert!(
        signature::verify(
            signature::secp256k1(),
            &sig_vectors::secp256k1_pk(),
            &msg,
            &sig_vectors::secp256k1_state_update_sig(),
        ),
    );
}

// ============================================
// NEGATIVE — a valid signature must NOT verify against a tampered
// message, a tampered signature, or the wrong party's key.
// ============================================

#[test]
fun rejects_wrong_party_key() {
    // party A's signature checked against party B's public key.
    let msg = state_update_msg();
    assert!(
        !signature::verify(
            signature::ed25519(),
            &sig_vectors::ed25519_pk_b(),
            &msg,
            &sig_vectors::ed25519_state_update_sig_a(),
        ),
    );
}

#[test]
fun rejects_tampered_message() {
    // Same fields except party_a_balance 1000 -> 1001: the signature is bound to
    // the original message bytes and must no longer verify.
    let id = sui::object::id_from_address(@0xab);
    let data = tunnel::create_state_update_data_for_testing(
        id,
        STATE_HASH,
        42,
        1234567890,
        1001,
        2000,
    );
    let tampered = tunnel::serialize_state_update(&data);
    assert!(
        !signature::verify(
            signature::ed25519(),
            &sig_vectors::ed25519_pk_a(),
            &tampered,
            &sig_vectors::ed25519_state_update_sig_a(),
        ),
    );
}

#[test]
fun rejects_tampered_signature() {
    let msg = state_update_msg();
    let mut bad = sig_vectors::ed25519_state_update_sig_a();
    let first = bad[0];
    *(&mut bad[0]) = first ^ 0xff;
    assert!(!signature::verify(signature::ed25519(), &sig_vectors::ed25519_pk_a(), &msg, &bad));
}

#[test]
fun rejects_cross_message_replay() {
    // A settlement signature must not verify as a state_update (distinct domain
    // separators make the message bytes disjoint), and vice versa.
    let su = state_update_msg();
    assert!(
        !signature::verify(
            signature::ed25519(),
            &sig_vectors::ed25519_pk_a(),
            &su,
            &sig_vectors::ed25519_settlement_sig_a(),
        ),
    );
    let settle = settlement_msg();
    assert!(
        !signature::verify(
            signature::ed25519(),
            &sig_vectors::ed25519_pk_a(),
            &settle,
            &sig_vectors::ed25519_state_update_sig_a(),
        ),
    );
}
