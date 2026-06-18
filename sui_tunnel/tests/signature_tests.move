#[test_only]
module sui_tunnel::signature_tests;

use std::unit_test::assert_eq;
use sui_tunnel::sig_vectors;
use sui_tunnel::signature;
use sui_tunnel::tunnel;

const STATE_HASH: vector<u8> = x"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

// Canonical state_update message that the fixed-secret ED25519/secp256k1 vectors in
// `sig_vectors` were produced over (matches signature_vectors_tests / wire_format_tests).
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
    data.serialize_state_update()
}

// A vector of `len` zero bytes, for length-validation fixtures.
fun zeros(len: u64): vector<u8> {
    let mut v = vector<u8>[];
    len.do!(|_| v.push_back(0));
    v
}

#[test]
fun signature_type_constants() {
    assert_eq!(signature::ed25519(), 0);
    assert_eq!(signature::bls12381_min_sig(), 1);
    assert_eq!(signature::bls12381_min_pk(), 2);
    assert_eq!(signature::secp256k1(), 3);
}

#[test]
fun hash_type_constants() {
    assert_eq!(signature::hash_keccak256(), 0);
    assert_eq!(signature::hash_sha256(), 1);
}

#[test]
fun signature_sizes() {
    assert_eq!(signature::signature_size(signature::ed25519()), 64);
    assert_eq!(signature::signature_size(signature::bls12381_min_sig()), 48);
    assert_eq!(signature::signature_size(signature::bls12381_min_pk()), 96);
    assert_eq!(signature::signature_size(signature::secp256k1()), 64);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::signature::EUnsupportedSignatureType,
        location = sui_tunnel::signature,
    ),
]
fun signature_size_unknown_type() {
    signature::signature_size(255);
}

#[test]
fun public_key_sizes() {
    assert_eq!(signature::public_key_size(signature::ed25519()), 32);
    assert_eq!(signature::public_key_size(signature::bls12381_min_sig()), 96);
    assert_eq!(signature::public_key_size(signature::bls12381_min_pk()), 48);
    assert_eq!(signature::public_key_size(signature::secp256k1()), 33);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::signature::EUnsupportedSignatureType,
        location = sui_tunnel::signature,
    ),
]
fun public_key_size_unknown_type() {
    signature::public_key_size(255);
}

#[test]
fun is_valid_signature_type() {
    assert!(signature::is_valid_signature_type(signature::ed25519()));
    assert!(signature::is_valid_signature_type(signature::bls12381_min_sig()));
    assert!(signature::is_valid_signature_type(signature::bls12381_min_pk()));
    assert!(signature::is_valid_signature_type(signature::secp256k1()));
    assert!(!signature::is_valid_signature_type(4));
    assert!(!signature::is_valid_signature_type(255));
}

#[test]
fun is_valid_public_key_length() {
    // ED25519: 32 bytes
    let pk_32 = vector[
        0u8,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    ];
    assert!(signature::is_valid_public_key_length(signature::ed25519(), &pk_32));
    assert!(!signature::is_valid_public_key_length(signature::ed25519(), &vector[0u8]));

    // BLS12381_MIN_PK: 48 bytes
    let mut pk_48 = vector<u8>[];
    let mut i = 0u64;
    while (i < 48) { pk_48.push_back(0); i = i + 1; };
    assert!(signature::is_valid_public_key_length(signature::bls12381_min_pk(), &pk_48));

    // BLS12381_MIN_SIG: 96 bytes
    let mut pk_96 = vector<u8>[];
    i = 0;
    while (i < 96) { pk_96.push_back(0); i = i + 1; };
    assert!(signature::is_valid_public_key_length(signature::bls12381_min_sig(), &pk_96));

    // Secp256k1: 33 bytes (compressed) or 65 bytes (uncompressed)
    let mut pk_33 = vector<u8>[];
    i = 0;
    while (i < 33) { pk_33.push_back(0); i = i + 1; };
    assert!(signature::is_valid_public_key_length(signature::secp256k1(), &pk_33));

    let mut pk_65 = vector<u8>[];
    i = 0;
    while (i < 65) { pk_65.push_back(0); i = i + 1; };
    assert!(signature::is_valid_public_key_length(signature::secp256k1(), &pk_65));
}

#[test]
fun u64_to_be_bytes() {
    let bytes = signature::u64_to_be_bytes(0);
    assert_eq!(bytes, vector[0u8, 0, 0, 0, 0, 0, 0, 0]);

    let bytes = signature::u64_to_be_bytes(1);
    assert_eq!(bytes, vector[0u8, 0, 0, 0, 0, 0, 0, 1]);

    let bytes = signature::u64_to_be_bytes(256);
    assert_eq!(bytes, vector[0u8, 0, 0, 0, 0, 0, 1, 0]);

    let bytes = signature::u64_to_be_bytes(0xFFFFFFFFFFFFFFFF);
    assert_eq!(bytes, vector[255u8, 255, 255, 255, 255, 255, 255, 255]);
}

#[test]
fun be_bytes_to_u64() {
    let value = signature::be_bytes_to_u64(&vector[0u8, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(value, 0);

    let value = signature::be_bytes_to_u64(&vector[0u8, 0, 0, 0, 0, 0, 0, 1]);
    assert_eq!(value, 1);

    let value = signature::be_bytes_to_u64(&vector[0u8, 0, 0, 0, 0, 0, 1, 0]);
    assert_eq!(value, 256);

    let value = signature::be_bytes_to_u64(&vector[255u8, 255, 255, 255, 255, 255, 255, 255]);
    assert_eq!(value, 0xFFFFFFFFFFFFFFFF);
}

#[test]
fun u64_roundtrip() {
    let values = vector[0u64, 1, 255, 256, 65535, 65536, 0xDEADBEEF, 0xFFFFFFFFFFFFFFFF];
    let len = values.length();
    let mut i = 0;

    while (i < len) {
        let original = *values.borrow(i);
        let bytes = signature::u64_to_be_bytes(original);
        let recovered = signature::be_bytes_to_u64(&bytes);
        assert_eq!(original, recovered);
        i = i + 1;
    };
}

#[test]
fun create_domain_separated_message() {
    let domain = b"test_domain";
    let message = b"hello";
    let result = signature::create_domain_separated_message(domain, message);

    // First byte should be domain length
    assert_eq!(*result.borrow(0), 11); // "test_domain".length() == 11

    // Check total length: 1 + 11 + 5 = 17
    assert_eq!(result.length(), 17);
}

#[test]
fun create_tunnel_message() {
    let tunnel_id = vector[1u8, 2, 3, 4];
    let nonce = 42u64;
    let data = b"test";
    let result = signature::create_tunnel_message(tunnel_id, nonce, data);

    // Should start with "sui_tunnel::signature::message"
    assert_eq!(*result.borrow(0), 115); // 's'
    assert_eq!(*result.borrow(1), 117); // 'u'
    assert_eq!(*result.borrow(2), 105); // 'i'
    assert_eq!(*result.borrow(3), 95); // '_'
    assert_eq!(*result.borrow(4), 116); // 't'

    // Total length: 30 (prefix) + 4 (id) + 8 (nonce) + 4 (data) = 46
    assert_eq!(result.length(), 46);
}

#[test]
fun concat_bytes() {
    let v1 = vector[1u8, 2, 3];
    let v2 = vector[4u8, 5];
    let v3 = vector[6u8];

    let result = signature::concat_bytes(vector[v1, v2, v3]);
    assert_eq!(result, vector[1u8, 2, 3, 4, 5, 6]);
}

#[test]
fun concat_bytes_empty() {
    let result = signature::concat_bytes(vector<vector<u8>>[]);
    assert_eq!(result, vector<u8>[]);
}

#[test]
fun hash_message() {
    let message = b"hello world";
    let hash_result = signature::hash_message(&message);

    // Blake2b-256 produces 32-byte output
    assert_eq!(hash_result.length(), 32);
}

// ============================================
// is_valid_signature_length — per-scheme accept/reject
// ============================================

#[test]
fun signature_length_accepts_correct_and_rejects_wrong() {
    // ED25519: 64 bytes.
    assert!(signature::is_valid_signature_length(signature::ed25519(), &zeros(64)));
    assert!(!signature::is_valid_signature_length(signature::ed25519(), &zeros(63)));
    assert!(!signature::is_valid_signature_length(signature::ed25519(), &zeros(65)));

    // BLS12381_MIN_SIG: 48-byte G1 signature.
    assert!(signature::is_valid_signature_length(signature::bls12381_min_sig(), &zeros(48)));
    assert!(!signature::is_valid_signature_length(signature::bls12381_min_sig(), &zeros(96)));

    // BLS12381_MIN_PK: 96-byte G2 signature.
    assert!(signature::is_valid_signature_length(signature::bls12381_min_pk(), &zeros(96)));
    assert!(!signature::is_valid_signature_length(signature::bls12381_min_pk(), &zeros(48)));

    // Secp256k1: only the 64-byte (r, s) form; the 65-byte recoverable form is rejected.
    assert!(signature::is_valid_signature_length(signature::secp256k1(), &zeros(64)));
    assert!(!signature::is_valid_signature_length(signature::secp256k1(), &zeros(65)));

    // Unknown scheme is never a valid length.
    assert!(!signature::is_valid_signature_length(255, &zeros(64)));
}

// ============================================
// verify — abort paths (mutate one field of a real ED25519 vector)
// ============================================

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::signature::EInvalidPublicKey,
        location = sui_tunnel::signature,
    ),
]
fun verify_aborts_on_short_public_key() {
    let msg = state_update_msg();
    // Valid ED25519 type + signature, but a 1-byte public key.
    signature::verify(
        signature::ed25519(),
        &vector[0u8],
        &msg,
        &sig_vectors::ed25519_state_update_sig_a(),
    );
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::signature::EInvalidSignature,
        location = sui_tunnel::signature,
    ),
]
fun verify_aborts_on_wrong_length_signature() {
    let msg = state_update_msg();
    // Valid ED25519 type + public key, but a 63-byte (truncated) signature.
    let mut sig = sig_vectors::ed25519_state_update_sig_a();
    sig.pop_back();
    signature::verify(signature::ed25519(), &sig_vectors::ed25519_pk_a(), &msg, &sig);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::signature::EUnsupportedSignatureType,
        location = sui_tunnel::signature,
    ),
]
fun verify_aborts_on_out_of_range_sig_type() {
    let msg = state_update_msg();
    // sig_type 255 is outside the supported set; type is validated before lengths.
    signature::verify(
        255,
        &sig_vectors::ed25519_pk_a(),
        &msg,
        &sig_vectors::ed25519_state_update_sig_a(),
    );
}

// ============================================
// Type-specific verifiers — positive real vectors
// ============================================

#[test]
fun verify_ed25519_accepts_real_vector() {
    let msg = state_update_msg();
    assert!(
        signature::verify_ed25519(
            &sig_vectors::ed25519_pk_a(),
            &msg,
            &sig_vectors::ed25519_state_update_sig_a(),
        ),
    );
    assert!(
        signature::verify_ed25519(
            &sig_vectors::ed25519_pk_b(),
            &msg,
            &sig_vectors::ed25519_state_update_sig_b(),
        ),
    );
}

#[test]
fun verify_secp256k1_accepts_real_vector() {
    // The secp256k1 vector is a low-s (r, s) signature over SHA256(state_update).
    let msg = state_update_msg();
    assert!(
        signature::verify_secp256k1(
            &sig_vectors::secp256k1_pk(),
            &msg,
            &sig_vectors::secp256k1_state_update_sig(),
            signature::hash_sha256(),
        ),
    );
}

// ============================================
// verify_with_hash — positive + wrong-length abort
// ============================================

#[test]
fun verify_with_hash_accepts_ed25519_and_secp256k1() {
    let msg = state_update_msg();
    // Non-secp256k1 schemes ignore hash_type and delegate to `verify`.
    assert!(
        signature::verify_with_hash(
            signature::ed25519(),
            &sig_vectors::ed25519_pk_a(),
            &msg,
            &sig_vectors::ed25519_state_update_sig_a(),
            signature::hash_keccak256(),
        ),
    );
    // Secp256k1 with the SHA256 hash the vector was produced under.
    assert!(
        signature::verify_with_hash(
            signature::secp256k1(),
            &sig_vectors::secp256k1_pk(),
            &msg,
            &sig_vectors::secp256k1_state_update_sig(),
            signature::hash_sha256(),
        ),
    );
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::signature::EInvalidSignature,
        location = sui_tunnel::signature,
    ),
]
fun verify_with_hash_aborts_on_wrong_length_signature() {
    let msg = state_update_msg();
    // 63-byte signature is rejected on the length check before any ECDSA work.
    let mut sig = sig_vectors::secp256k1_state_update_sig();
    sig.pop_back();
    signature::verify_with_hash(
        signature::secp256k1(),
        &sig_vectors::secp256k1_pk(),
        &msg,
        &sig,
        signature::hash_sha256(),
    );
}

// ============================================
// BLS12381 verifiers — length-rejection abort paths
//
// Positive BLS real-signature vectors require signing off-chain (no Move-test
// keypair), so only the input-length guards are exercised here.
// ============================================

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::signature::EInvalidPublicKey,
        location = sui_tunnel::signature,
    ),
]
fun verify_bls12381_min_sig_rejects_wrong_length_public_key() {
    // min_sig expects a 96-byte G2 public key; pass 48 bytes.
    signature::verify_bls12381_min_sig(&zeros(48), &b"msg", &zeros(48));
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::signature::EInvalidSignature,
        location = sui_tunnel::signature,
    ),
]
fun verify_bls12381_min_sig_rejects_wrong_length_signature() {
    // min_sig expects a 48-byte G1 signature; pass 96 bytes.
    signature::verify_bls12381_min_sig(&zeros(96), &b"msg", &zeros(96));
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::signature::EInvalidPublicKey,
        location = sui_tunnel::signature,
    ),
]
fun verify_bls12381_min_pk_rejects_wrong_length_public_key() {
    // min_pk expects a 48-byte G1 public key; pass 96 bytes.
    signature::verify_bls12381_min_pk(&zeros(96), &b"msg", &zeros(96));
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::signature::EInvalidSignature,
        location = sui_tunnel::signature,
    ),
]
fun verify_bls12381_min_pk_rejects_wrong_length_signature() {
    // min_pk expects a 96-byte G2 signature; pass 48 bytes.
    signature::verify_bls12381_min_pk(&zeros(48), &b"msg", &zeros(48));
}
