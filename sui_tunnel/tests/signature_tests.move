#[test_only]
module sui_tunnel::signature_tests;

use std::unit_test::assert_eq;
use sui_tunnel::signature;

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
