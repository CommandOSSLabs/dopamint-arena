//! Create a 1,000,000-member wallet pool in S3 incrementally.
//!
//! The pool is created empty, then members are added in 10,000-member batches.
//! If interrupted, rerunning the example resumes from the current member count.
//!
//! Required environment variables:
//!   - `ACCESS_VALUE` — a passphrase that will seal (and unseal) the pool.
//!   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` — S3 credentials.
//!   - `WALLET_POOL_S3_BUCKET` — S3 bucket name.
//!
//! Optional environment variables:
//!   - `WALLET_POOL_ID` — resume an existing pool instead of creating a new one.
//!   - `SUI_RPC_URL` — defaults to `https://fullnode.testnet.sui.io:443`.
//!
//! The pool is sealed with `AccessMode::Passphrase`, so `ACCESS_VALUE` can be
//! any passphrase you choose.
//!
//! Run:
//!   export ACCESS_VALUE=...
//!   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1
//!   export WALLET_POOL_S3_BUCKET=dev-env-dopamint-wallet-pool
//!   cargo run -p wallet-pool-s3 --example s3_create_1m_pool

use std::sync::Arc;
use wallet_pool::rpc::ReqwestRpc;
use wallet_pool::{AddMembersOptions, CacheMode, CreateOptions, Network, OpenOptions, WalletPool};
use wallet_pool_core::crypto::ed25519_address;
use wallet_pool_core::envelope::AccessMode;
use wallet_pool_s3::S3WalletPoolStore;

const TARGET_MEMBERS: u32 = 1_000_000;
const BATCH_SIZE: u32 = 10_000;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let rpc_url = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".into());

    // Derive the access value first so it is used both when creating and when
    // resuming a pool.
    let access_value =
        std::env::var("ACCESS_VALUE").expect("set ACCESS_VALUE to the pool's access value");

    let store = Arc::new(S3WalletPoolStore::from_env().await?);
    let rpc = Arc::new(ReqwestRpc::new(rpc_url));
    let pool = WalletPool::new(store.clone(), rpc);

    // Create an empty pool or open an existing one to resume.
    let pool_id = match std::env::var("WALLET_POOL_ID") {
        Ok(id) if !id.is_empty() => {
            println!("Resuming pool {id} …");
            id
        }
        _ => {
            println!("Creating empty pool …");
            let created = pool
                .create(CreateOptions {
                    network: Network::Testnet,
                    member_count: 0,
                    access_value: Some(access_value.clone()),
                    access_mode: AccessMode::Passphrase,
                    ..Default::default()
                })
                .await?;
            println!("Created pool {}", created.wallet_pool_id);
            created.wallet_pool_id
        }
    };

    // Check current member count.
    let handle = pool
        .open(OpenOptions {
            id: pool_id.clone(),
            access_value: access_value.clone(),
            network: Network::Testnet,
            cache_mode: CacheMode::None,
        })
        .await?;

    let mut current_members = handle.member_count();
    let master_key = handle.get_member_key(wallet_pool::By::Ordinal(0))?;
    let master_address = ed25519_address(&master_key.public_key());
    println!("Current members: {current_members}");
    println!("Master address: {master_address}");
    handle.close();

    // Add members in batches until we reach 1M.
    while current_members < TARGET_MEMBERS {
        let remaining = TARGET_MEMBERS - current_members;
        let batch = BATCH_SIZE.min(remaining);
        let start = std::time::Instant::now();

        let result = pool
            .add_members(AddMembersOptions {
                id: pool_id.clone(),
                access_value: access_value.clone(),
                additional_count: batch,
            })
            .await?;

        current_members = result.total_member_count;
        println!(
            "Added {} members in {:?}. Total: {}/{TARGET_MEMBERS}",
            batch,
            start.elapsed(),
            current_members
        );
    }

    println!("\n================ POOL READY ================");
    println!("Network:   testnet");
    println!("Pool id:   {pool_id}");
    println!("Access value (SECRET):");
    println!("  {access_value}");
    println!("Master address: {master_address}");
    println!("Total members: {current_members}");
    println!("============================================");

    Ok(())
}
