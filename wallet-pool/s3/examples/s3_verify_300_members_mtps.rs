//! Verify that the first 300 members of a pool each hold 100,000 MTPS.
//!
//! Run after `s3_fund_300_members_mtps` to confirm the funding landed.
//!
//! Required environment variables:
//!   - `WALLET_POOL_ID` — pool id to verify (e.g. `wp_…`).
//!   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` — S3 credentials.
//!   - `WALLET_POOL_S3_BUCKET` — S3 bucket name.
//!
//! Optional environment variables:
//!   - `SUI_RPC_URL` — defaults to `https://fullnode.testnet.sui.io:443`.
//!   - `FUND_AMOUNT` — expected MTPS per recipient (default 100_000).
//!   - `FUND_RECIPIENT_COUNT` — number of members to verify (default 300).

use std::sync::Arc;
use wallet_pool::rpc::{ReqwestRpc, SuiRpc};
use wallet_pool::{Filter, ListOptions, Pagination, WalletPool, WalletRole};
use wallet_pool_s3::S3WalletPoolStore;

const MTPS_COIN_TYPE: &str =
    "0xe0f8eae320959eb7300cb599a6e7a287355c60b299a7e80a808d9196e0aea8ea::mtps::MTPS";
const DEFAULT_FUND_AMOUNT: u64 = 100_000;
const DEFAULT_RECIPIENT_COUNT: usize = 300;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let rpc_url = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".into());
    let pool_id = std::env::var("WALLET_POOL_ID").expect("set WALLET_POOL_ID");
    let expected_amount: u64 = std::env::var("FUND_AMOUNT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_FUND_AMOUNT);
    let recipient_count: usize = std::env::var("FUND_RECIPIENT_COUNT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_RECIPIENT_COUNT);

    let store = Arc::new(S3WalletPoolStore::from_env().await?);
    let rpc = Arc::new(ReqwestRpc::new(rpc_url));
    let pool = WalletPool::new(store, rpc.clone());

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

    println!(
        "Verifying each of the first {recipient_count} members holds {expected_amount} MTPS …"
    );

    let mut ok = 0;
    let mut missing = 0;
    let mut mismatches: Vec<(String, u64)> = Vec::new();

    for (i, member) in members.iter().enumerate() {
        let balances = rpc.get_all_balances(&member.address).await?;
        let mtps_balance = balances
            .iter()
            .find(|b| b.coin_type == MTPS_COIN_TYPE)
            .map(|b| b.total_balance)
            .unwrap_or(0);

        if mtps_balance == expected_amount {
            ok += 1;
        } else if mtps_balance == 0 {
            missing += 1;
            mismatches.push((member.address.clone(), mtps_balance));
        } else {
            mismatches.push((member.address.clone(), mtps_balance));
        }

        if (i + 1) % 50 == 0 {
            println!("  checked {}/{} …", i + 1, recipient_count);
        }
    }

    println!("\nVerification complete:");
    println!("  OK:       {ok}/{recipient_count}");
    println!("  Missing:  {missing}");
    println!("  Mismatched: {}", mismatches.len() - missing);

    if !mismatches.is_empty() {
        println!("\nFirst 10 mismatches:");
        for (addr, bal) in mismatches.iter().take(10) {
            println!("  {addr}: {bal}");
        }
        return Err("verification failed: not all members hold the expected MTPS amount".into());
    }

    Ok(())
}
