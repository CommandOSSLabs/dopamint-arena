//! Smoke test against the REAL funded wallet pool (PR #124). `#[ignore]` by default — it needs
//! `WALLET_POOL_ID` / `WALLET_POOL_ACCESS_VALUE` / `WALLET_POOL_S3_BUCKET` + `AWS_*` + `SUI_RPC_URL`
//! and pulls the ~332 MiB blob from S3. Answers two things the design hinges on: (a) does the blob
//! carry a free (no-RPC) funding record, and (b) what's the funding distribution — i.e. is naive
//! round-robin viable, or does most of the pool come up empty?
//!
//! Run: `cargo test -p tunnel-manager --test wallet_pool_smoke -- --ignored --nocapture`
//!
//! Note `list`/`view_balance` are on `WalletPool` and re-read the whole 332 MiB blob per call, so we
//! open the handle once, call `list` once for the funding record, and hit the rpc directly for the
//! per-wallet balances (no blob re-read).

use std::sync::Arc;

use wallet_pool::rpc::{ReqwestRpc, SuiRpc};
use wallet_pool::{By, CacheMode, Network, OpenOptions, WalletPool};
use wallet_pool_s3::S3WalletPoolStore;

#[tokio::test]
#[ignore]
async fn real_pool_funding_distribution() {
    let id = std::env::var("WALLET_POOL_ID").expect("WALLET_POOL_ID");
    let access = std::env::var("WALLET_POOL_ACCESS_VALUE").expect("WALLET_POOL_ACCESS_VALUE");
    let rpc_url = std::env::var("SUI_RPC_URL").expect("SUI_RPC_URL");

    let store = Arc::new(
        S3WalletPoolStore::from_env()
            .await
            .expect("s3 store from_env"),
    );
    let rpc = Arc::new(ReqwestRpc::new(rpc_url));
    let pool = WalletPool::new(store, rpc.clone());
    let handle = pool
        .open(OpenOptions {
            id: id.clone(),
            access_value: access,
            network: Network::Testnet,
            cache_mode: CacheMode::None,
        })
        .await
        .expect("open pool");

    let n = handle.member_count();
    println!("member_count = {n}");
    assert!(n > 0, "pool has members");

    // NOTE: `pool.list`/`view_balance` re-stream the whole 332 MiB blob per call (and the handle does
    // not expose the in-memory entries), so the blob's `funded_amounts` record is NOT cheaply readable
    // at this scale — confirmed by `list` failing with an S3 streaming error here. So we go straight to
    // live balances via the rpc (in-memory key derivation, no blob re-read).

    // Map the funded boundary: a geometric+linear sweep of ordinals to find how many low members are
    // funded (the funded subset to round-robin over). Direct rpc, no blob re-read.
    println!("--- funded-boundary sweep ---");
    let probes: Vec<u32> = vec![
        1, 2, 3, 5, 10, 20, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000,
    ];
    for ord in probes {
        if ord > n {
            break;
        }
        let kp = handle.get_member_key(By::Ordinal(ord)).expect("member key");
        let addr = wallet_pool_core::crypto::ed25519_address(&kp.public_key());
        let balances = rpc.get_all_balances(&addr).await.expect("get_all_balances");
        let mtps = balances
            .iter()
            .find(|b| b.coin_type.ends_with("::mtps::MTPS"))
            .map_or(0, |b| b.total_balance);
        println!("ordinal {ord:>7}  mtps={mtps}");
    }
}
