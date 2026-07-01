//! Transfer MTPS from a wallet-pool master to a single recipient using a local
//! pool blob file.
//!
//! This avoids S3 credentials when the blob has already been downloaded.
//!
//! Required environment variables:
//!   - `WALLET_POOL_ID` — pool id whose master will send.
//!   - `ACCESS_VALUE` — passphrase that unlocks the pool.
//!   - `POOL_FILE_DIR` — directory containing `{id}.json`.
//!   - `RECIPIENT` — recipient Sui address.
//!   - `AMOUNT` — MTPS amount to transfer.
//!
//! Optional environment variables:
//!   - `SUI_RPC_URL` — defaults to `https://fullnode.testnet.sui.io:443`.

use std::sync::Arc;
use wallet_pool::rpc::ReqwestRpc;
use wallet_pool::store::FileWalletPoolStore;
use wallet_pool::{CacheMode, FundOptions, Network, OpenOptions, WalletPool};

const MTPS_COIN_TYPE: &str =
    "0xe0f8eae320959eb7300cb599a6e7a287355c60b299a7e80a808d9196e0aea8ea::mtps::MTPS";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let rpc_url = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".into());
    let pool_id = std::env::var("WALLET_POOL_ID").expect("set WALLET_POOL_ID");
    let access_value = std::env::var("ACCESS_VALUE").expect("set ACCESS_VALUE");
    let pool_dir = std::env::var("POOL_FILE_DIR").expect("set POOL_FILE_DIR");
    let recipient = std::env::var("RECIPIENT").expect("set RECIPIENT");
    let amount: u64 = std::env::var("AMOUNT")
        .expect("set AMOUNT")
        .parse()
        .expect("AMOUNT must be a u64");

    let store = Arc::new(FileWalletPoolStore::new(&pool_dir));
    let rpc = Arc::new(ReqwestRpc::new(rpc_url));
    let pool = WalletPool::new(store, rpc);

    println!(
        "Opening pool {pool_id} from {pool_dir} and transferring {amount} MTPS to {recipient} …"
    );

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
