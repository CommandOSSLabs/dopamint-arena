//! Create a PERSISTENT 50-wallet pool in S3, fund it with BUCK, and print the
//! credentials a consumer needs to open and use it. Does NOT delete the pool.
//!
//! This is the "operator" recipe: run once to stand up a shared online pool,
//! then hand the printed pool id + access_value (+ the AWS env vars) to anyone
//! who needs to use it.
//!
//! Run:
//!   sui client switch --env testnet
//!   export SUI_RPC_URL=https://fullnode.testnet.sui.io:443
//!   export BUCK_OBJECT_ID=<a_buck_coin_owned_by_your_active_address>
//!   export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_REGION=us-east-1
//!   export WALLET_POOL_S3_BUCKET=dev-env-dopamint-wallet-pool
//!   cargo run -p wallet-pool-s3 --example s3_create_pool

use std::process::Command;
use std::sync::Arc;
use wallet_pool::rpc::{ReqwestRpc, SuiRpc};
use wallet_pool::store::WalletPoolStore;
use wallet_pool::{
    By, CacheMode, CreateOptions, Filter, FundOptions, ListOptions, Network, OpenOptions,
    WalletPool, WalletRole,
};
use wallet_pool_core::crypto::ed25519_address;
use wallet_pool_s3::S3WalletPoolStore;

const SUI_COIN_TYPE: &str = "0x2::sui::SUI";
const BUCK_COIN_TYPE: &str =
    "0x52fa24986ed45532b871326114454b711f99c7f7c57294a28d82cedc1fc78a70::test_buck::TEST_BUCK";
const MASTER_FUND_GAS_MIST: u64 = 2_000_000_000; // 2 SUI for the master's gas
const MASTER_FUND_BUCK: u64 = 1_000_000_000; // 1 BUCK to distribute
const MEMBER_FUND_BUCK: u64 = 10_000_000; // 0.01 BUCK per member (50 = 0.5 BUCK)
const SIGNER_GAS_MIST: u64 = 100_000_000; // 0.1 SUI gas per sign-ready member
const NUM_SIGN_READY: usize = 5; // first N members get SUI gas so they can sign

async fn wait_for_balance(
    rpc: &dyn SuiRpc,
    address: &str,
    coin_type: &str,
    min_balance: u64,
    attempts: usize,
) {
    for i in 0..attempts {
        if let Ok(balances) = rpc.get_all_balances(address).await {
            let total: u64 = balances
                .iter()
                .filter(|b| b.coin_type == coin_type)
                .map(|b| b.total_balance)
                .sum();
            if total >= min_balance {
                println!("  {coin_type} ready: {total} after {} attempt(s)", i + 1);
                return;
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    panic!("{coin_type} did not reach {min_balance} for {address}");
}

fn fund_master_sui(master: &str, amount: u64) -> String {
    // pick the largest gas coin of the CLI active address
    let out = Command::new("sui")
        .args(["client", "gas", "--json"])
        .output()
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let coin = json
        .as_array()
        .unwrap()
        .iter()
        .max_by_key(|c| c["mistBalance"].as_u64())
        .unwrap();
    let coin_id = coin["gasCoinId"].as_str().unwrap();
    println!("Funding master {MASTER_FUND_GAS_MIST} MIST from CLI coin {coin_id}");
    let out = Command::new("sui")
        .args([
            "client",
            "transfer-sui",
            "--to",
            master,
            "--sui-coin-object-id",
            coin_id,
            "--amount",
            &amount.to_string(),
            "--gas-budget",
            "5000000",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    v["digest"].as_str().unwrap().to_string()
}

fn fund_master_buck(master: &str, buck_object_id: &str, amount: u64) -> String {
    println!("Funding master 1 BUCK from CLI object {buck_object_id}");
    let out = Command::new("sui")
        .args([
            "client",
            "pay",
            "--input-coins",
            buck_object_id,
            "--recipients",
            master,
            "--amounts",
            &amount.to_string(),
            "--gas-budget",
            "5000000",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    v["digest"].as_str().unwrap().to_string()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let rpc_url = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".into());
    let buck_object_id = std::env::var("BUCK_OBJECT_ID")
        .expect("set BUCK_OBJECT_ID to a testnet BUCK coin owned by the CLI active address");

    let store = Arc::new(S3WalletPoolStore::from_env().await?);
    let rpc = Arc::new(ReqwestRpc::new(rpc_url));
    let pool = WalletPool::new(store.clone(), rpc.clone());

    // 1. Create a 50-member pool persisted to S3.
    println!("Creating a 50-member pool in S3 …");
    let created = pool
        .create(CreateOptions {
            network: Network::Testnet,
            member_count: 50,
            ..Default::default()
        })
        .await?;
    let pool_id = created.wallet_pool_id.clone();
    let access_value = created.access_value.clone();
    println!("  pool id: {pool_id}");
    println!(
        "  persisted in S3: {}",
        store.list().await?.contains(&pool_id)
    );

    // 2. Open and derive the master address.
    let mut handle = pool
        .open(OpenOptions {
            id: pool_id.clone(),
            access_value: access_value.clone(),
            network: Network::Testnet,
            cache_mode: CacheMode::Default,
        })
        .await?;
    let master_key = handle.get_member_key(By::Ordinal(0))?;
    let master_address = ed25519_address(&master_key.public_key());
    println!("  master address: {master_address}");

    // 3. Fund master with SUI (gas) and 1 BUCK (to distribute).
    let d = fund_master_sui(&master_address, MASTER_FUND_GAS_MIST);
    println!("  master SUI digest: {d}");
    wait_for_balance(
        rpc.as_ref(),
        &master_address,
        SUI_COIN_TYPE,
        MASTER_FUND_GAS_MIST,
        30,
    )
    .await;
    let d = fund_master_buck(&master_address, &buck_object_id, MASTER_FUND_BUCK);
    println!("  master BUCK digest: {d}");
    wait_for_balance(
        rpc.as_ref(),
        &master_address,
        BUCK_COIN_TYPE,
        MASTER_FUND_BUCK,
        30,
    )
    .await;

    // 4. Fund all members with BUCK.
    let members = pool
        .list(ListOptions {
            id: pool_id.clone(),
            filter: Filter {
                role: Some(WalletRole::Member),
                ..Default::default()
            },
            ..Default::default()
        })
        .await?;
    let recipients: Vec<String> = members.iter().map(|m| m.address.clone()).collect();
    let d = handle
        .fund(FundOptions {
            coin_type: Some(BUCK_COIN_TYPE.into()),
            amount_per_recipient: MEMBER_FUND_BUCK,
            recipients: recipients.clone(),
            await_effects: true,
        })
        .await?;
    println!("Funded {} members with BUCK, digest: {d}", recipients.len());

    // 5. Fund the first NUM_SIGN_READY members with SUI gas so they can sign.
    let sign_ready: Vec<String> = recipients.iter().take(NUM_SIGN_READY).cloned().collect();
    let d = handle
        .fund(FundOptions {
            coin_type: Some(SUI_COIN_TYPE.into()),
            amount_per_recipient: SIGNER_GAS_MIST,
            recipients: sign_ready.clone(),
            await_effects: true,
        })
        .await?;
    println!("Funded {NUM_SIGN_READY} members with SUI gas, digest: {d}");

    // 6. Verify: members holding BUCK.
    let funded = pool
        .list(ListOptions {
            id: pool_id.clone(),
            filter: Filter {
                role: Some(WalletRole::Member),
                coin_type: Some(BUCK_COIN_TYPE.into()),
                balance_min: Some(1),
                ..Default::default()
            },
            live_balances: true,
            ..Default::default()
        })
        .await?;
    println!(
        "Members with BUCK balance >= 1: {} (expected 50)",
        funded.len()
    );

    let member0 = recipients[0].clone();

    // 7. Print the handoff block. Do NOT delete — leave the pool in S3.
    println!("\n================ POOL READY — HANDOFF ================");
    println!("Network:   testnet");
    println!("Pool id:   {pool_id}");
    println!("Access value (SECRET — decrypts every member key):");
    println!("  {access_value}");
    println!("Master address: {master_address}");
    println!("Sample member (ordinal 0, sign-ready): {member0}");
    println!("Sign-ready members (have SUI gas): ordinals 0..{NUM_SIGN_READY}");
    println!("-----------------------------------------------------");
    println!("Consumer env vars:");
    println!("  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION,");
    println!("  WALLET_POOL_S3_BUCKET, SUI_RPC_URL  (+ pool id + access_value above)");
    println!("=====================================================");

    handle.close(); // wipe in-memory keys; pool stays in S3
    Ok(())
}
