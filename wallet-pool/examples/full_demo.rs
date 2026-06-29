//! Live end-to-end demo of the Rust wallet-pool library.
//!
//! This example:
//! 1. Creates a pool with 50 member wallets.
//! 2. Funds the pool master with 0.5 SUI taken from the local `sui client gas` coin.
//! 3. Funds the 50 members from the master (one member gets enough to sign a tx).
//! 4. Signs and executes a member-to-master transfer PTB.
//! 5. Lists entries with filters and live balances.
//! 6. Exercises selection helpers (pick / next / lru).
//! 7. Exports, imports, disables, re-enables, and deletes the pool.
//!
//! Run against a local network started with:
//!   sui start --with-faucet --force-regenesis
//!
//! Then:
//!   SUI_RPC_URL=http://127.0.0.1:9000 cargo run -p wallet-pool --example full_demo

use std::collections::HashMap;
use std::process::Command;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use sui_sdk_types::Address;
use sui_transaction_builder::{ObjectInput, TransactionBuilder};
use wallet_pool::rpc::{ReqwestRpc, SuiRpc};
use wallet_pool::store::FileWalletPoolStore;
use wallet_pool::{
    BalanceOptions, By, CacheMode, CreateOptions, CreateResult, Filter, FundOptions, ListOptions,
    Network, OpenOptions, SetEnabledOptions, SignAndExecuteOptions, WalletPool, WalletRole,
};
use wallet_pool_core::crypto::ed25519_address;

const SUI_COIN_TYPE: &str = "0x2::sui::SUI";
const MASTER_FUND_MIST: u64 = 500_000_000; // 0.5 SUI
const MEMBER_FUND_MIST: u64 = 1_000_000; // 0.001 SUI for 49 members
const SIGNER_FUND_MIST: u64 = 100_000_000; // 0.1 SUI for the signing member

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

async fn wait_for_balance(
    rpc: &dyn wallet_pool::rpc::SuiRpc,
    address: &str,
    min_balance: u64,
    attempts: usize,
) {
    for i in 0..attempts {
        match rpc.get_all_balances(address).await {
            Ok(balances) => {
                let total: u64 = balances
                    .iter()
                    .filter(|b| b.coin_type == SUI_COIN_TYPE)
                    .map(|b| b.total_balance)
                    .sum();
                if total >= min_balance {
                    println!("  balance ready: {} MIST after {} attempt(s)", total, i + 1);
                    return;
                }
            }
            Err(e) => eprintln!("  balance check failed: {e}"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    panic!("balance did not reach {min_balance} for {address}");
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

fn fund_master_from_cli(master_address: &str, amount: u64) -> String {
    let coin_id = cli_gas_coin();
    println!("Funding master from CLI coin {coin_id} with {amount} MIST");
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

fn build_transfer_ptb(
    sender: Address,
    recipient: Address,
    gas_coin: &wallet_pool::rpc::Coin,
) -> sui_sdk_types::ProgrammableTransaction {
    let object_id = Address::from_hex(&gas_coin.object_id).expect("valid gas object id");
    let digest = sui_sdk_types::Digest::from_base58(&gas_coin.digest).expect("valid digest");

    let mut tx = TransactionBuilder::new();
    tx.set_sender(sender);
    tx.set_gas_budget(50_000_000);
    tx.set_gas_price(1_000);
    tx.add_gas_objects([ObjectInput::owned(object_id, gas_coin.version, digest)]);

    let coin_arg = tx.gas();
    let recipient_arg = tx.pure(&recipient);
    tx.transfer_objects(vec![coin_arg], recipient_arg);

    let transaction = tx.try_build().expect("build PTB");
    match transaction.kind {
        sui_sdk_types::TransactionKind::ProgrammableTransaction(ptb) => ptb,
        _ => panic!("expected a programmable transaction"),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let rpc_url = std::env::var("SUI_RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:9000".into());
    println!("Connecting to {rpc_url}");

    let dir = tempfile::tempdir()?;
    let store = Arc::new(FileWalletPoolStore::new(dir.path()));
    let rpc = Arc::new(ReqwestRpc::new(rpc_url));
    let pool = WalletPool::new(store, rpc.clone());

    // 1. Create pool.
    println!("\n1. Creating pool with 50 members");
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

    // 3. Fund master from sui client gas.
    println!("\n3. Funding master with 0.5 SUI from sui client gas");
    let fund_master_digest = fund_master_from_cli(&master_address, MASTER_FUND_MIST);
    println!("   CLI transfer digest: {fund_master_digest}");
    wait_for_balance(rpc.as_ref(), &master_address, MASTER_FUND_MIST, 30).await;

    // 4. List all entries.
    println!("\n4. Listing all {} entries", member_count + 1);
    let all = pool
        .list(ListOptions {
            id: wallet_pool_id.clone(),
            ..Default::default()
        })
        .await?;
    println!("   returned {} entries", all.len());

    // 5. Filter to members only.
    println!("\n5. Filtering to members only");
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

    // 6. Fund members: one signer gets enough for gas, the rest get 0.001 SUI.
    println!("\n6. Funding members from master");
    let recipients: Vec<String> = members.iter().map(|m| m.address.clone()).collect();
    // Fund the first member (ordinal 1) with more SUI so it can sign a tx.
    let signer_address = recipients[0].clone();
    let mut amounts: HashMap<String, u64> = HashMap::new();
    amounts.insert(signer_address.clone(), SIGNER_FUND_MIST);
    for addr in &recipients[1..] {
        amounts.insert(addr.clone(), MEMBER_FUND_MIST);
    }
    // Use per-recipient funding by calling fund twice: once for signer, once for the rest.
    let signer_fund_digest = handle
        .fund(FundOptions {
            coin_type: Some(SUI_COIN_TYPE.into()),
            amount_per_recipient: SIGNER_FUND_MIST,
            recipients: vec![signer_address.clone()],
            await_effects: true,
        })
        .await?;
    println!("   signer fund digest: {signer_fund_digest}");

    let rest: Vec<String> = recipients[1..].to_vec();
    let rest_fund_digest = handle
        .fund(FundOptions {
            coin_type: Some(SUI_COIN_TYPE.into()),
            amount_per_recipient: MEMBER_FUND_MIST,
            recipients: rest,
            await_effects: true,
        })
        .await?;
    println!("   remaining members fund digest: {rest_fund_digest}");

    wait_for_balance(rpc.as_ref(), &signer_address, SIGNER_FUND_MIST, 30).await;

    // 7. Sign and execute a member-to-master transfer.
    println!("\n7. Signing and executing member -> master transfer");
    let _signer_key = handle.get_member_key(By::Address(signer_address.clone()))?;
    let signer_address_obj = Address::from_hex(&signer_address)?;
    let master_address_obj = Address::from_hex(&master_address)?;
    let signer_coins = rpc.get_coins(&signer_address, SUI_COIN_TYPE).await?;
    let gas_coin = signer_coins.first().expect("signer should have a SUI coin");
    let ptb = build_transfer_ptb(signer_address_obj, master_address_obj, gas_coin);
    let sign_digest = handle
        .sign_and_execute(SignAndExecuteOptions {
            by: By::Address(signer_address.clone()),
            ptb,
            await_effects: true,
        })
        .await?;
    println!("   sign-and-execute digest: {sign_digest}");

    // 8. Live balances for the signer.
    println!("\n8. Viewing live balances for signer");
    let balances = pool
        .view_balance(BalanceOptions {
            id: wallet_pool_id.clone(),
            address: Some(signer_address.clone()),
        })
        .await?;
    println!("   {:#?}", balances);

    // 9. List with live-balance filter.
    println!("\n9. Listing members with non-zero SUI balance");
    let funded = pool
        .list(ListOptions {
            id: wallet_pool_id.clone(),
            filter: Filter {
                role: Some(WalletRole::Member),
                coin_type: Some(SUI_COIN_TYPE.into()),
                balance_min: Some(1),
                ..Default::default()
            },
            live_balances: true,
            ..Default::default()
        })
        .await?;
    println!("   members with SUI balance >= 1: {}", funded.len());

    // 10. Selection helpers.
    println!("\n10. Selection helpers");
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

    // 11. Export and import.
    println!("\n11. Export / import round-trip");
    let exported = pool.export(&wallet_pool_id).await?;
    let imported_id = pool.import(&exported).await?;
    println!("   exported {} bytes", exported.len());
    println!("   import returned id: {imported_id}");
    assert_eq!(imported_id, wallet_pool_id);

    // 12. Disable and re-enable signer.
    println!("\n12. Disable and re-enable member");
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

    // 13. Delete pool.
    println!("\n13. Deleting pool");
    pool.delete(&wallet_pool_id).await?;
    let remaining = pool.list_pools().await?;
    println!("   pools remaining after delete: {}", remaining.len());

    // 14. Close handle to clear in-memory secrets.
    handle.close();
    println!("\nDemo complete.");
    Ok(())
}
