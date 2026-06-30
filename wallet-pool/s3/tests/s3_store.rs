//! Integration tests for `S3WalletPoolStore`.
//!
//! The S3-backed tests are env-gated: they skip unless
//! `WALLET_POOL_S3_BUCKET` is set (with `AWS_*` credentials configured).
//! `key_rejects_invalid_ids` is pure and runs without credentials.

use aws_sdk_s3::Client;
use wallet_pool_s3::S3WalletPoolStore;

/// A client with no region/credentials. Safe because the validation test never
/// sends a request — `key()` fails before the client is touched.
fn dummy_client() -> Client {
    let cfg = aws_sdk_s3::Config::builder()
        .behavior_version_latest()
        .build();
    Client::from_conf(cfg)
}

#[test]
fn key_rejects_invalid_ids() {
    let store = S3WalletPoolStore::new(dummy_client(), "anybucket", "");

    for bad in ["wp_", "no_prefix", "wp_a/b", "wp_a\\b", "wp_a.b", "wp_a b"] {
        assert!(store.key(bad).is_err(), "id {bad:?} should be rejected");
    }
    assert!(store.key("wp_ok").is_ok());

    let prefixed = S3WalletPoolStore::new(dummy_client(), "b", "pools/");
    assert_eq!(prefixed.key("wp_ok").unwrap(), "pools/wp_ok.json");
}
