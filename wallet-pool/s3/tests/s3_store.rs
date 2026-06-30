//! Integration tests for `S3WalletPoolStore`.
//!
//! The S3-backed tests are env-gated: they skip unless
//! `WALLET_POOL_S3_BUCKET` is set (with `AWS_*` credentials configured).
//! `key_rejects_invalid_ids` is pure and runs without credentials.

use aws_sdk_s3::Client;
use std::time::{SystemTime, UNIX_EPOCH};
use wallet_pool::store::WalletPoolStore;
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

/// Skip helper: returns `Some(store)` with an isolated random prefix, or `None`
/// (after printing a skip notice) when the bucket env var is unset.
async fn gated_store() -> Option<S3WalletPoolStore> {
    let bucket_unset = std::env::var("WALLET_POOL_S3_BUCKET")
        .map(|v| v.trim().is_empty())
        .unwrap_or(true);
    if bucket_unset {
        eprintln!("skipped: WALLET_POOL_S3_BUCKET not set");
        return None;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .load()
        .await;
    let bucket = std::env::var("WALLET_POOL_S3_BUCKET").unwrap();
    Some(S3WalletPoolStore::new(
        Client::new(&config),
        bucket,
        format!("test-{nanos}/"),
    ))
}

#[tokio::test]
async fn read_missing_returns_none() {
    let store = match gated_store().await {
        Some(s) => s,
        None => return,
    };
    assert!(store.read("wp_missing").await.unwrap().is_none());
}

#[tokio::test]
async fn write_then_read_round_trip() {
    let store = match gated_store().await {
        Some(s) => s,
        None => return,
    };
    store.write("wp_abc", b"hello s3").await.unwrap();
    let got = store.read("wp_abc").await.unwrap().unwrap();
    assert_eq!(got, b"hello s3");
    // Object intentionally left under the isolated test-<nanos>/ prefix;
    // trivial dev-bucket data that does not affect other tests.
}
