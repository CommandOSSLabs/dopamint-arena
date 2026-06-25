//! Whole-engine parity gate against the captured golden.gen.ts vectors.
//! No external deps beyond hex; the JSON is read as a raw string and the fields
//! matched by name to keep the test dependency-free.

use rustbench::engine::commitment::{combine_reveals, compute_commitment};
use rustbench::engine::crypto::{blake2b256, keypair_from_secret};
use rustbench::engine::wire::{
    serialize_htlc_lock, serialize_settlement, serialize_settlement_with_root,
    serialize_state_update, HtlcLock, Settlement, StateUpdate,
};

fn field(json: &str, key: &str) -> String {
    let needle = format!("\"{key}\"");
    let start = json.find(&needle).expect("key present");
    let after = &json[start + needle.len()..];
    let colon = after.find(':').unwrap();
    let q1 = after[colon..].find('"').unwrap() + colon + 1;
    let q2 = after[q1..].find('"').unwrap() + q1;
    after[q1..q2].to_string()
}

#[test]
fn engine_reproduces_all_golden_vectors() {
    let json = include_str!("vectors/core.json");
    let sh: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);

    let su = serialize_state_update(&StateUpdate {
        tunnel_id: "0xab".into(), state_hash: sh, nonce: 42,
        timestamp: 1234567890, party_a_balance: 1000, party_b_balance: 2000,
    });
    assert_eq!(hex::encode(&su), field(json, "state_update"));

    let settle = serialize_settlement(&Settlement {
        tunnel_id: "0xab".into(), party_a_balance: 1000, party_b_balance: 2000,
        final_nonce: 43, timestamp: 1234567890,
    });
    assert_eq!(hex::encode(&settle), field(json, "settlement"));

    let settle_v2 = serialize_settlement_with_root(&Settlement {
        tunnel_id: "0xab".into(), party_a_balance: 1000, party_b_balance: 2000,
        final_nonce: 43, timestamp: 1234567890,
    }, &sh);
    assert_eq!(hex::encode(&settle_v2), field(json, "settlement_v2"));

    let htlc = serialize_htlc_lock(&HtlcLock {
        tunnel_id: "0xab".into(), payment_hash: sh, amount: 500,
        sender: "0xaa".into(), receiver: "0xbb".into(), expiry_ms: 9999999,
    });
    assert_eq!(hex::encode(&htlc), field(json, "htlc_lock"));

    let salt_a: Vec<u8> = (1u8..=16).collect();
    let salt_b: Vec<u8> = (17u8..=32).collect();
    assert_eq!(hex::encode(compute_commitment(&[7], &salt_a).unwrap()), field(json, "commitment"));
    assert_eq!(hex::encode(combine_reveals(&[7], &salt_a, &[42], &salt_b)), field(json, "seed"));
    assert_eq!(hex::encode(blake2b256(b"hello")), field(json, "blake2b_hello"));

    let secret: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let kp = keypair_from_secret(&secret);
    assert_eq!(hex::encode(kp.public_key()), field(json, "pk_a"));
    assert_eq!(hex::encode(kp.sign(&su)), field(json, "sig_a"));
}
