//! Live end-to-end demo of the **online** wallet-pool (S3-backed) funding and
//! exercising every feature with a non-SUI token (BUCK). Identical to
//! `wallet-pool/examples/full_demo_buck.rs` except the store is S3, not disk.
//!
//! This example:
//! 1. Creates a pool of 50 member wallets — stored as an encrypted blob in S3.
//! 2. Confirms the blob is actually in the S3 bucket.
//! 3. Funds the pool master with 1 BUCK + 1 SUI for gas (via the `sui` CLI).
//! 4. Funds the 50 members with BUCK from the master.
//! 5. Funds the signing member with SUI for gas.
//! 6. Signs and executes a BUCK member-to-master transfer PTB.
//! 7. Lists entries with BUCK balance filters; exercises selection helpers.
//! 8. Exports, imports, disables, re-enables, and deletes the pool.
//!
//! Run:
//!   sui client switch --env testnet
//!   export SUI_RPC_URL=https://fullnode.testnet.sui.io:443
//!   export BUCK_OBJECT_ID=<your_buck_coin_object_id>
//!   export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_REGION=us-east-1
//!   export WALLET_POOL_S3_BUCKET=dev-env-dopamint-wallet-pool
//!   cargo run -p wallet-pool-s3 --example s3_full_demo_buck

use std::process::Command;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use sui_sdk_types::Address;
use sui_transaction_builder::{ObjectInput, TransactionBuilder};
use wallet_pool::rpc::{ReqwestRpc, SuiRpc};
use wallet_pool::store::WalletPoolStore;
use wallet_pool::{
    BalanceOptions, By, CacheMode, CreateOptions, CreateResult, Filter, FundOptions, ListOptions,
    Network, OpenOptions, SetEnabledOptions, SignAndExecuteOptions, WalletPool, WalletRole,
};
use wallet_pool_core::crypto::ed25519_address;
use wallet_pool_s3::S3WalletPoolStore;

const SUI_COIN_TYPE: &str = "0x2::sui::SUI";
const BUCK_COIN_TYPE: &str =
    "0x52fa24986ed45532b871326114454b711f99c7f7c57294a28d82cedc1fc78a70::test_buck::TEST_BUCK";
const BUCK_DECIMALS: u64 = 1_000_000_000;
const MASTER_FUND_BUCK: u64 = BUCK_DECIMALS; // 1 BUCK
const MASTER_FUND_GAS_MIST: u64 = 1_000_000_000; // 1 SUI for gas
const MEMBER_FUND_BUCK: u64 = 10_000_000; // 0.01 BUCK for 49 members
const SIGNER_FUND_BUCK: u64 = 50_000_000; // 0.05 BUCK for the signing member
const SIGNER_GAS_MIST: u64 = 100_000_000; // 0.1 SUI for the signing member

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

async fn wait_for_token_balance(
    rpc: &dyn SuiRpc,
    address: &str,
    coin_type: &str,
    min_balance: u64,
    attempts: usize,
) {
    for i in 0..attempts {
        match rpc.get_all_balances(address).await {
            Ok(balances) => {
                let total: u64 = balances
                    .iter()
                    .filter(|b| b.coin_type == coin_type)
                    .map(|b| b.total_balance)
                    .sum();
                if total >= min_balance {
                    println!(
                        "  {coin_type} balance ready: {total} after {} attempt(s)",
                        i + 1
                    );
                    return;
                }
            }
            Err(e) => eprintln!("  balance check failed: {e}"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    panic!("{coin_type} balance did not reach {min_balance} for {address}");
}

fn cli_gas_coin() -> String {
    let output = Command::new("sui")
        .args(["client", "gas", "--json"])
        .output()
        .expect("sui client gas failed");
    if !output.status.success() {
        panic!(
            "sui client gas failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("failed to parse sui client gas output");
    let coins = json.as_array().expect("gas output is not an array");
    let coin = coins
        .iter()
        .max_by_key(|c| c["mistBalance"].as_u64())
        .expect("no gas coins");
    coin["gasCoinId"]
        .as_str()
        .expect("gasCoinId missing")
        .to_string()
}

fn fund_master_sui_from_cli(master_address: &str, amount: u64) -> String {
    let coin_id = cli_gas_coin();
    println!("Funding master SUI from CLI coin {coin_id} with {amount} MIST");
    let output = Command::new("sui")
        .args([
            "client",
            "transfer-sui",
            "--to",
            master_address,
            "--sui-coin-object-id",
            &coin_id,
            "--amount",
            &amount.to_string(),
            "--gas-budget",
            "5000000",
            "--json",
        ])
        .output()
        .expect("sui client transfer-sui failed");
    if !output.status.success() {
        panic!(
            "sui client transfer-sui failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .expect("failed to parse sui client transfer-sui output");
    json["digest"].as_str().expect("digest missing").to_string()
}

fn fund_master_buck_from_cli(master_address: &str, buck_object_id: &str, amount: u64) -> String {
    println!("Funding master BUCK from CLI object {buck_object_id} with {amount} units");
    let output = Command::new("sui")
        .args([
            "client",
            "pay",
            "--input-coins",
            buck_object_id,
            "--recipients",
            master_address,
            "--amounts",
            &amount.to_string(),
            "--gas-budget",
            "5000000",
            "--json",
        ])
        .output()
        .expect("sui client pay failed");
    if !output.status.success() {
        panic!(
            "sui client pay failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("failed to parse sui client pay output");
    json["digest"].as_str().expect("digest missing").to_string()
}

fn build_buck_transfer_ptb(
    sender: Address,
    recipient: Address,
    gas_coin: &wallet_pool::rpc::Coin,
    buck_coin: &wallet_pool::rpc::Coin,
) -> sui_sdk_types::ProgrammableTransaction {
    let gas_object_id = Address::from_hex(&gas_coin.object_id).expect("valid gas object id");
    let gas_digest = sui_sdk_types::Digest::from_base58(&gas_coin.digest).expect("valid digest");
    let buck_object_id = Address::from_hex(&buck_coin.object_id).expect("valid buck object id");
    let buck_digest = sui_sdk_types::Digest::from_base58(&buck_coin.digest).expect("valid digest");

    let mut tx = TransactionBuilder::new();
    tx.set_sender(sender);
    tx.set_gas_budget(50_000_000);
    tx.set_gas_price(1_000);
    tx.add_gas_objects([ObjectInput::owned(
        gas_object_id,
        gas_coin.version,
        gas_digest,
    )]);

    let buck_arg = tx.object(ObjectInput::owned(
        buck_object_id,
        buck_coin.version,
        buck_digest,
    ));
    let recipient_arg = tx.pure(&recipient);
    tx.transfer_objects(vec![buck_arg], recipient_arg);

    let transaction = tx.try_build().expect("build PTB");
    match transaction.kind {
        sui_sdk_types::TransactionKind::ProgrammableTransaction(ptb) => ptb,
        _ => panic!("expected a programmable transaction"),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let rpc_url = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".into());
    let buck_object_id = std::env::var("BUCK_OBJECT_ID")
        .expect("set BUCK_OBJECT_ID to a testnet BUCK coin owned by the CLI active address");
    println!("Connecting to {rpc_url}");
    println!("Using BUCK object {buck_object_id}");
    println!("Storage: Amazon S3 (bucket from WALLET_POOL_S3_BUCKET)");

    // Online pool: store lives in S3, not on disk.
    let store = Arc::new(S3WalletPoolStore::from_env().await?);
    let rpc = Arc::new(ReqwestRpc::new(rpc_url));
    let pool = WalletPool::new(store.clone(), rpc.clone());

    // 1. Create pool.
    println!("\n1. Creating pool with 50 members (persisted to S3)");
    let CreateResult {
        wallet_pool_id,
        access_value,
        network,
        member_count,
    } = pool
        .create(CreateOptions {
            network: Network::Testnet,
            member_count: 50,
            ..Default::default()
        })
        .await?;
    println!("   pool id: {wallet_pool_id}");
    println!("   members: {member_count}");

    // 1b. PROOF: the blob is actually in the S3 bucket.
    let bucket_ids = store.list().await?;
    println!(
        "   S3 bucket contains pool id {}: {}",
        wallet_pool_id,
        bucket_ids.contains(&wallet_pool_id)
    );

    // 2. Open pool and get master address.
    println!("\n2. Opening pool and deriving master address");
    let mut handle = pool
        .open(OpenOptions {
            id: wallet_pool_id.clone(),
            access_value: access_value.clone(),
            network,
            cache_mode: CacheMode::Default,
        })
        .await?;
    let master_key = handle.get_member_key(By::Ordinal(0))?;
    let master_address = ed25519_address(&master_key.public_key());
    println!("   master address: {master_address}");

    // 3. Fund master with SUI for gas.
    println!("\n3. Funding master with {MASTER_FUND_GAS_MIST} MIST for gas");
    let fund_gas_digest = fund_master_sui_from_cli(&master_address, MASTER_FUND_GAS_MIST);
    println!("   CLI SUI transfer digest: {fund_gas_digest}");
    wait_for_token_balance(
        rpc.as_ref(),
        &master_address,
        SUI_COIN_TYPE,
        MASTER_FUND_GAS_MIST,
        30,
    )
    .await;

    // 4. Fund master with 1 BUCK.
    println!("\n4. Funding master with 1 BUCK");
    let fund_buck_digest =
        fund_master_buck_from_cli(&master_address, &buck_object_id, MASTER_FUND_BUCK);
    println!("   CLI BUCK pay digest: {fund_buck_digest}");
    wait_for_token_balance(
        rpc.as_ref(),
        &master_address,
        BUCK_COIN_TYPE,
        MASTER_FUND_BUCK,
        30,
    )
    .await;

    // 5. List all entries.
    println!("\n5. Listing all {} entries", member_count + 1);
    let all = pool
        .list(ListOptions {
            id: wallet_pool_id.clone(),
            ..Default::default()
        })
        .await?;
    println!("   returned {} entries", all.len());

    // 6. Filter to members only.
    println!("\n6. Filtering to members only");
    let members = pool
        .list(ListOptions {
            id: wallet_pool_id.clone(),
            filter: Filter {
                role: Some(WalletRole::Member),
                ..Default::default()
            },
            ..Default::default()
        })
        .await?;
    println!("   members: {}", members.len());

    // 7. Fund members with BUCK: signer gets more, rest get 0.01 BUCK.
    println!("\n7. Funding members from master with BUCK");
    let recipients: Vec<String> = members.iter().map(|m| m.address.clone()).collect();
    let signer_address = recipients[0].clone();

    let signer_fund_digest = handle
        .fund(FundOptions {
            coin_type: Some(BUCK_COIN_TYPE.into()),
            amount_per_recipient: SIGNER_FUND_BUCK,
            recipients: vec![signer_address.clone()],
            await_effects: true,
        })
        .await?;
    println!("   signer BUCK fund digest: {signer_fund_digest}");

    let rest: Vec<String> = recipients[1..].to_vec();
    let rest_fund_digest = handle
        .fund(FundOptions {
            coin_type: Some(BUCK_COIN_TYPE.into()),
            amount_per_recipient: MEMBER_FUND_BUCK,
            recipients: rest,
            await_effects: true,
        })
        .await?;
    println!("   remaining members BUCK fund digest: {rest_fund_digest}");

    wait_for_token_balance(
        rpc.as_ref(),
        &signer_address,
        BUCK_COIN_TYPE,
        SIGNER_FUND_BUCK,
        30,
    )
    .await;

    // 8. Fund the signer with SUI for gas.
    println!("\n8. Funding signer with SUI for gas");
    let signer_gas_fund_digest = handle
        .fund(FundOptions {
            coin_type: Some(SUI_COIN_TYPE.into()),
            amount_per_recipient: SIGNER_GAS_MIST,
            recipients: vec![signer_address.clone()],
            await_effects: true,
        })
        .await?;
    println!("   signer SUI gas fund digest: {signer_gas_fund_digest}");
    wait_for_token_balance(
        rpc.as_ref(),
        &signer_address,
        SUI_COIN_TYPE,
        SIGNER_GAS_MIST,
        30,
    )
    .await;

    // 9. Sign and execute a BUCK member-to-master transfer.
    println!("\n9. Signing and executing member -> master BUCK transfer");
    let signer_address_obj = Address::from_hex(&signer_address)?;
    let master_address_obj = Address::from_hex(&master_address)?;
    let signer_sui_coins = rpc.get_coins(&signer_address, SUI_COIN_TYPE).await?;
    let gas_coin = signer_sui_coins
        .first()
        .expect("signer should have a SUI coin");
    let signer_buck_coins = rpc.get_coins(&signer_address, BUCK_COIN_TYPE).await?;
    let buck_coin = signer_buck_coins
        .first()
        .expect("signer should have a BUCK coin");
    let ptb = build_buck_transfer_ptb(signer_address_obj, master_address_obj, gas_coin, buck_coin);
    let sign_digest = handle
        .sign_and_execute(SignAndExecuteOptions {
            by: By::Address(signer_address.clone()),
            ptb,
            await_effects: true,
        })
        .await?;
    println!("   sign-and-execute BUCK digest: {sign_digest}");

    // 10. Live BUCK balances for the signer.
    println!("\n10. Viewing live BUCK balances for signer");
    let balances = pool
        .view_balance(BalanceOptions {
            id: wallet_pool_id.clone(),
            address: Some(signer_address.clone()),
        })
        .await?;
    println!("   {:#?}", balances);

    // 11. List with live BUCK balance filter.
    println!("\n11. Listing members with non-zero BUCK balance");
    let funded = pool
        .list(ListOptions {
            id: wallet_pool_id.clone(),
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
    println!("   members with BUCK balance >= 1: {}", funded.len());

    // 12. Selection helpers.
    println!("\n12. Selection helpers");
    let now = now_ms();
    let cursor = &mut 0u32;
    let pick = wallet_pool_core::select::pick(
        &members,
        &Filter {
            role: Some(WalletRole::Member),
            ..Default::default()
        },
        &None,
        now,
    );
    let next = wallet_pool_core::select::next(
        &members,
        &Filter {
            role: Some(WalletRole::Member),
            ..Default::default()
        },
        &None,
        now,
        cursor,
    );
    let lru = wallet_pool_core::select::lru(
        &members,
        &Filter {
            role: Some(WalletRole::Member),
            ..Default::default()
        },
        &None,
        now,
    );
    println!("   pick ordinal: {:?}", pick.map(|e| e.ordinal));
    println!("   next ordinal: {:?}", next.map(|e| e.ordinal));
    println!("   lru ordinal: {:?}", lru.map(|e| e.ordinal));

    // 13. Export and import (round-trips through S3).
    println!("\n13. Export / import round-trip");
    let exported = pool.export(&wallet_pool_id).await?;
    let imported_id = pool.import(&exported).await?;
    println!("   exported {} bytes", exported.len());
    println!("   import returned id: {imported_id}");
    assert_eq!(imported_id, wallet_pool_id);

    // 14. Disable and re-enable signer.
    println!("\n14. Disable and re-enable member");
    pool.set_enabled(SetEnabledOptions {
        id: wallet_pool_id.clone(),
        by: By::Address(signer_address.clone()),
        enabled: false,
    })
    .await?;
    let disabled = pool
        .list(ListOptions {
            id: wallet_pool_id.clone(),
            filter: Filter {
                address_exact: Some(signer_address.clone()),
                ..Default::default()
            },
            ..Default::default()
        })
        .await?;
    println!("   signer enabled after disable: {}", disabled[0].enabled);

    pool.set_enabled(SetEnabledOptions {
        id: wallet_pool_id.clone(),
        by: By::Address(signer_address.clone()),
        enabled: true,
    })
    .await?;
    let re_enabled = pool
        .list(ListOptions {
            id: wallet_pool_id.clone(),
            filter: Filter {
                address_exact: Some(signer_address.clone()),
                ..Default::default()
            },
            ..Default::default()
        })
        .await?;
    println!(
        "   signer enabled after re-enable: {}",
        re_enabled[0].enabled
    );

    // 15. Delete pool — and prove it's gone from S3.
    println!("\n15. Deleting pool");
    pool.delete(&wallet_pool_id).await?;
    let remaining = pool.list_pools().await?;
    println!("   pools remaining after delete: {}", remaining.len());
    let bucket_after = store.list().await?;
    println!(
        "   pool id still in S3 after delete: {}",
        bucket_after.contains(&wallet_pool_id)
    );

    // 16. Close handle to clear in-memory secrets.
    handle.close();
    println!("\nOnline (S3) BUCK demo complete.");
    Ok(())
}
