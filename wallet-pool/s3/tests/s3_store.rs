//! Integration tests for `S3WalletPoolStore`.
//!
//! The S3-backed tests are env-gated: they skip unless
//! `WALLET_POOL_S3_BUCKET` is set (with `AWS_*` credentials configured).
//! `key_rejects_invalid_ids` is pure and runs without credentials.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use aws_sdk_s3::Client;
use wallet_pool::{
    error::Result,
    rpc::{Balance, Coin, ExecuteResponse, SuiRpc},
    store::WalletPoolStore,
    AddMembersOptions, CacheMode, CreateOptions, ListOptions, Network, OpenOptions, WalletPool,
};
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

/// Test-only RPC implementation that returns empty/successful defaults.
///
/// `add_members_on_s3` exercises only the S3 store, so a no-op RPC is safe.
#[derive(Clone, Debug, Default)]
struct NoOpRpc;

#[async_trait]
impl SuiRpc for NoOpRpc {
    async fn get_all_balances(&self, _address: &str) -> Result<Vec<Balance>> {
        Ok(vec![])
    }

    async fn get_coins(&self, _owner: &str, _coin_type: &str) -> Result<Vec<Coin>> {
        Ok(vec![])
    }

    async fn execute_transaction(
        &self,
        _tx_bytes: &[u8],
        _signatures: Vec<Vec<u8>>,
    ) -> Result<ExecuteResponse> {
        Ok(ExecuteResponse {
            digest: String::new(),
            effects: None,
        })
    }

    async fn wait_for_transaction(&self, _digest: &str) -> Result<()> {
        Ok(())
    }

    async fn faucet_request(&self, _address: &str) -> Result<()> {
        Ok(())
    }
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

#[tokio::test]
async fn list_returns_sorted_ids() {
    let store = match gated_store().await {
        Some(s) => s,
        None => return,
    };
    store.write("wp_b", b"2").await.unwrap();
    store.write("wp_a", b"1").await.unwrap();

    let ids = store.list().await.unwrap();
    // Isolated prefix => only this test's objects are listed.
    assert_eq!(ids, vec!["wp_a".to_string(), "wp_b".to_string()]);

    store.delete("wp_a").await.unwrap();
    store.delete("wp_b").await.unwrap();
}

#[tokio::test]
async fn delete_missing_is_ok() {
    let store = match gated_store().await {
        Some(s) => s,
        None => return,
    };
    // Deleting a key that was never written must succeed (idempotent).
    store.delete("wp_never_existed").await.unwrap();
}

#[tokio::test]
async fn delete_removes_object() {
    let store = match gated_store().await {
        Some(s) => s,
        None => return,
    };
    store.write("wp_gone", b"x").await.unwrap();
    store.delete("wp_gone").await.unwrap();
    assert!(store.read("wp_gone").await.unwrap().is_none());
}

#[tokio::test]
async fn add_members_on_s3() {
    let store = match gated_store().await {
        Some(s) => s,
        None => return,
    };
    let store = Arc::new(store);
    let rpc = Arc::new(NoOpRpc);
    let pool = WalletPool::new(store.clone(), rpc);

    let created = pool
        .create(CreateOptions {
            network: Network::Testnet,
            member_count: 1,
            ..Default::default()
        })
        .await
        .unwrap();

    let result = pool
        .add_members(AddMembersOptions {
            id: created.wallet_pool_id.clone(),
            access_value: created.access_value.clone(),
            additional_count: 2,
        })
        .await
        .unwrap();

    assert_eq!(result.total_member_count, 3);

    let handle = pool
        .open(OpenOptions {
            id: created.wallet_pool_id.clone(),
            access_value: created.access_value,
            network: Network::Testnet,
            cache_mode: CacheMode::None,
        })
        .await
        .unwrap();

    let entries = pool
        .list(ListOptions {
            id: created.wallet_pool_id.clone(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(entries.len(), 4); // master + 3 members

    drop(handle);

    // Clean up.
    pool.delete(&created.wallet_pool_id).await.unwrap();
}
