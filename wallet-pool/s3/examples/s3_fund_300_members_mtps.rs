//! Fund 300 pool members with 100,000 MTPS each from the master wallet.
//!
//! The script reads the first 300 member addresses from the pool and sends the
//! tokens in batched PTBs (100 recipients per transaction by default).
//!
//! Required environment variables:
//!   - `ACCESS_VALUE` — passphrase that unlocks the pool.
//!   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` — S3 credentials.
//!   - `WALLET_POOL_S3_BUCKET` — S3 bucket name.
//!   - `WALLET_POOL_ID` — pool id to fund (e.g. `wp_…`).
//!
//! Optional environment variables:
//!   - `SUI_RPC_URL` — defaults to `https://fullnode.testnet.sui.io:443`.
//!   - `FUND_BATCH_SIZE` — recipients per transaction (default 100).
//!   - `FUND_AMOUNT` — MTPS per recipient (default 100_000).
//!   - `FUND_RECIPIENT_COUNT` — number of members to fund (default 300).
//!
//! Run:
//!   export ACCESS_VALUE=...
//!   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1
//!   export WALLET_POOL_S3_BUCKET=dev-env-dopamint-wallet-pool
//!   export WALLET_POOL_ID=wp_...
//!   cargo run -p wallet-pool-s3 --example s3_fund_300_members_mtps

use std::sync::Arc;
use wallet_pool::{
    CacheMode, Filter, FundBatchOptions, ListOptions, Network, OpenOptions, Pagination,
    WalletPool, WalletRole,
};
use wallet_pool::rpc::ReqwestRpc;
use wallet_pool_s3::S3WalletPoolStore;

const MTPS_COIN_TYPE: &str =
    "0xe0f8eae320959eb7300cb599a6e7a287355c60b299a7e80a808d9196e0aea8ea::mtps::MTPS";
const DEFAULT_FUND_AMOUNT: u64 = 100_000;
const DEFAULT_RECIPIENT_COUNT: usize = 300;
const DEFAULT_BATCH_SIZE: usize = 100;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let rpc_url = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".into());
    let pool_id = std::env::var("WALLET_POOL_ID").expect("set WALLET_POOL_ID");
    let access_value = std::env::var("ACCESS_VALUE").expect("set ACCESS_VALUE");
    let fund_amount: u64 = std::env::var("FUND_AMOUNT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_FUND_AMOUNT);
    let recipient_count: usize = std::env::var("FUND_RECIPIENT_COUNT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_RECIPIENT_COUNT);
    let batch_size: usize = std::env::var("FUND_BATCH_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_BATCH_SIZE);

    let store = Arc::new(S3WalletPoolStore::from_env().await?);
    let rpc = Arc::new(ReqwestRpc::new(rpc_url));
    let pool = WalletPool::new(store, rpc);

    // Read the first N member addresses from the pool.
    println!("Reading {recipient_count} member addresses from pool {pool_id} …");
    let members = pool
        .list(ListOptions {
            id: pool_id.clone(),
            filter: Filter {
                role: Some(WalletRole::Member),
                ..Default::default()
            },
            sort: None,
            pagination: Some(Pagination {
                offset: 0,
                limit: Some(recipient_count),
            }),
            live_balances: false,
        })
        .await?;

    if members.len() < recipient_count {
        return Err(format!(
            "pool only has {} members, requested {}",
            members.len(),
            recipient_count
        )
        .into());
    }

    let recipients: Vec<String> = members.iter().map(|m| m.address.clone()).collect();
    let total = fund_amount * recipient_count as u64;
    println!("Funding {recipient_count} members with {fund_amount} MTPS each (total {total}) …");

    // Open the pool to sign the funding transactions as the master.
    let mut handle = pool
        .open(OpenOptions {
            id: pool_id,
            access_value,
            network: Network::Testnet,
            cache_mode: CacheMode::None,
        })
        .await?;

    let digests = handle
        .fund_batch(FundBatchOptions {
            coin_type: Some(MTPS_COIN_TYPE.into()),
            amount_per_recipient: fund_amount,
            recipients,
            max_recipients_per_tx: batch_size,
            await_effects: true,
        })
        .await?;

    handle.close();

    println!("\nFunded in {} transaction(s):", digests.len());
    for (i, digest) in digests.iter().enumerate() {
        println!("  [{}/{}] {}", i + 1, digests.len(), digest);
    }

    Ok(())
}
