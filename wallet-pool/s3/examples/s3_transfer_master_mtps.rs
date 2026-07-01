//! Transfer MTPS from a wallet-pool master to a single recipient.
//!
//! Required environment variables:
//!   - `WALLET_POOL_ID` — pool id whose master will send.
//!   - `ACCESS_VALUE` — passphrase that unlocks the pool.
//!   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` — S3 credentials.
//!   - `WALLET_POOL_S3_BUCKET` — S3 bucket name.
//!   - `RECIPIENT` — recipient Sui address.
//!   - `AMOUNT` — MTPS amount to transfer.
//!
//! Optional environment variables:
//!   - `SUI_RPC_URL` — defaults to `https://fullnode.testnet.sui.io:443`.
//!
//! Run:
//!   export WALLET_POOL_ID=wp_...
//!   export ACCESS_VALUE=...
//!   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1
//!   export WALLET_POOL_S3_BUCKET=dev-env-dopamint-wallet-pool
//!   export RECIPIENT=0x...
//!   export AMOUNT=600000000
//!   cargo run -p wallet-pool-s3 --example s3_transfer_master_mtps

use std::sync::Arc;
use wallet_pool::rpc::ReqwestRpc;
use wallet_pool::{CacheMode, FundOptions, Network, OpenOptions, WalletPool};
use wallet_pool_s3::S3WalletPoolStore;

const MTPS_COIN_TYPE: &str =
    "0xe0f8eae320959eb7300cb599a6e7a287355c60b299a7e80a808d9196e0aea8ea::mtps::MTPS";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let rpc_url = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".into());
    let pool_id = std::env::var("WALLET_POOL_ID").expect("set WALLET_POOL_ID");
    let access_value = std::env::var("ACCESS_VALUE").expect("set ACCESS_VALUE");
    let recipient = std::env::var("RECIPIENT").expect("set RECIPIENT");
    let amount: u64 = std::env::var("AMOUNT")
        .expect("set AMOUNT")
        .parse()
        .expect("AMOUNT must be a u64");

    let store = Arc::new(S3WalletPoolStore::from_env().await?);
    let rpc = Arc::new(ReqwestRpc::new(rpc_url));
    let pool = WalletPool::new(store, rpc);

    println!("Opening pool {pool_id} and transferring {amount} MTPS to {recipient} …");

    let mut handle = pool
        .open(OpenOptions {
            id: pool_id,
            access_value,
            network: Network::Testnet,
            cache_mode: CacheMode::None,
        })
        .await?;

    let digest = handle
        .fund(FundOptions {
            coin_type: Some(MTPS_COIN_TYPE.into()),
            amount_per_recipient: amount,
            recipients: vec![recipient],
            await_effects: true,
        })
        .await?;

    handle.close();

    println!("\nTransfer succeeded: {digest}");

    Ok(())
}
