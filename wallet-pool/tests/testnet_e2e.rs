//! Gated testnet lifecycle test for the wallet-pool library.
//!
//! Run with:
//!   WALLET_POOL_TESTNET=1 SUI_RPC_URL=https://fullnode.testnet.sui.io:443 \
//!     SUI_FAUCET_URL=https://faucet.testnet.sui.io \
//!     cargo test -p wallet-pool --test testnet_e2e -- --nocapture

use std::sync::Arc;
use std::time::Duration;
use sui_sdk_types::Address;
use sui_transaction_builder::{ObjectInput, TransactionBuilder};
use tempfile::TempDir;
use wallet_pool::rpc::{ReqwestRpc, SuiRpc};
use wallet_pool::store::FileWalletPoolStore;
use wallet_pool::{
    BalanceOptions, By, CacheMode, CreateOptions, CreateResult, Filter, FundOptions, ListOptions,
    Network, OpenOptions, SetEnabledOptions, SignAndExecuteOptions, WalletPool, WalletRole,
};

const SUI_COIN_TYPE: &str = "0x2::sui::SUI";
const GAS_BUDGET: u64 = 50_000_000;
const GAS_PRICE: u64 = 1_000;

fn skip_unless_enabled() -> Option<(String, String)> {
    if std::env::var("WALLET_POOL_TESTNET").is_err() {
        return None;
    }
    let rpc = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".into());
    let faucet =
        std::env::var("SUI_FAUCET_URL").unwrap_or_else(|_| "https://faucet.testnet.sui.io".into());
    Some((rpc, faucet))
}

async fn wait_for_balance(
    rpc: &dyn SuiRpc,
    address: &str,
    min_balance: u64,
    attempts: usize,
) -> bool {
    for _ in 0..attempts {
        match rpc.get_all_balances(address).await {
            Ok(balances) => {
                let total: u64 = balances
                    .iter()
                    .filter(|b| b.coin_type == SUI_COIN_TYPE)
                    .map(|b| b.total_balance)
                    .sum();
                if total >= min_balance {
                    return true;
                }
            }
            Err(e) => eprintln!("balance check failed: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    false
}

#[tokio::test]
async fn full_lifecycle_on_testnet() {
    let (rpc_url, faucet_url) = match skip_unless_enabled() {
        Some(urls) => urls,
        None => {
            eprintln!("Skipping testnet e2e; set WALLET_POOL_TESTNET=1 to run.");
            return;
        }
    };

    let dir = TempDir::new().unwrap();
    let store = Arc::new(FileWalletPoolStore::new(dir.path()));
    let rpc = Arc::new(ReqwestRpc::new(rpc_url).with_faucet_url(faucet_url));
    let pool = WalletPool::new(store, rpc.clone());

    // 1. Create pool with 2 members.
    let CreateResult {
        wallet_pool_id,
        access_value,
        network,
        member_count,
    } = pool
        .create(CreateOptions {
            network: Network::Testnet,
            member_count: 2,
            ..Default::default()
        })
        .await
        .expect("create pool");

    assert_eq!(member_count, 2);
    assert!(wallet_pool_id.starts_with("wp_"));

    // 2. Open pool to find master address.
    let mut handle = pool
        .open(OpenOptions {
            id: wallet_pool_id.clone(),
            access_value: access_value.clone(),
            network,
            cache_mode: CacheMode::Default,
        })
        .await
        .expect("open pool");

    let master_address = handle
        .get_member_key(By::Ordinal(0))
        .map(|kp| wallet_pool_core::crypto::ed25519_address(&kp.public_key()))
        .expect("master key");

    // 3. Request SUI from faucet for the master.
    rpc.faucet_request(&master_address)
        .await
        .expect("faucet request");

    // 4. Wait for faucet balance.
    let funded = wait_for_balance(rpc.as_ref(), &master_address, 100_000_000, 20).await;
    assert!(funded, "master did not receive faucet SUI in time");

    // 5. Find member addresses.
    let members = pool
        .list(ListOptions {
            id: wallet_pool_id.clone(),
            filter: Filter {
                role: Some(WalletRole::Member),
                ..Default::default()
            },
            ..Default::default()
        })
        .await
        .expect("list members");
    assert_eq!(members.len(), 2);
    let recipient_addresses: Vec<String> = members.iter().map(|m| m.address.clone()).collect();

    // 6. Fund members.
    let fund_digest = handle
        .fund(FundOptions {
            coin_type: Some(SUI_COIN_TYPE.into()),
            amount_per_recipient: 10_000_000,
            recipients: recipient_addresses.clone(),
            await_effects: true,
        })
        .await
        .expect("fund members");
    assert!(!fund_digest.is_empty());

    // 7. Get member key and sign a simple transfer back to master.
    let member_key = handle.get_member_key(By::Ordinal(1)).expect("member key");
    let member_address = wallet_pool_core::crypto::ed25519_address(&member_key.public_key());

    // Wait for member balance.
    let member_funded = wait_for_balance(rpc.as_ref(), &member_address, 5_000_000, 20).await;
    assert!(member_funded, "member did not receive funded SUI in time");

    // Build a PTB: transfer 1 MIST back to master.
    let sender = Address::from_hex(&member_address).expect("valid member address");
    let member_coins = rpc
        .get_coins(&member_address, SUI_COIN_TYPE)
        .await
        .expect("get member coins");
    let coin = member_coins.first().expect("member has a SUI coin");

    let mut tx = TransactionBuilder::new();
    tx.set_sender(sender);
    tx.set_gas_budget(GAS_BUDGET);
    tx.set_gas_price(GAS_PRICE);
    tx.add_gas_objects([ObjectInput::owned(
        Address::from_hex(&coin.object_id).expect("valid object id"),
        coin.version,
        sui_sdk_types::Digest::from_base58(&coin.digest).expect("valid digest"),
    )]);

    let coin_arg = tx.gas();
    let recipient = Address::from_hex(&master_address).expect("valid master address");
    let recipient_arg = tx.pure(&recipient);
    tx.transfer_objects(vec![coin_arg], recipient_arg);

    let transaction = tx.try_build().expect("build ptb");
    let ptb = match transaction.kind {
        sui_sdk_types::TransactionKind::ProgrammableTransaction(ptb) => ptb,
        _ => panic!("expected a programmable transaction"),
    };

    let sign_digest = handle
        .sign_and_execute(SignAndExecuteOptions {
            by: By::Ordinal(1),
            ptb,
            await_effects: true,
        })
        .await
        .expect("sign and execute");
    assert!(!sign_digest.is_empty());

    // 8. List live balances.
    let balances = pool
        .view_balance(BalanceOptions {
            id: wallet_pool_id.clone(),
            address: Some(member_address.clone()),
        })
        .await
        .expect("view balance");
    assert!(balances.contains_key(&member_address));

    // 9. Export and import.
    let exported = pool.export(&wallet_pool_id).await.expect("export");
    let imported_id = pool.import(&exported).await.expect("import");
    assert_eq!(imported_id, wallet_pool_id);

    // 10. Disable and re-enable a member.
    pool.set_enabled(SetEnabledOptions {
        id: wallet_pool_id.clone(),
        by: By::Ordinal(1),
        enabled: false,
    })
    .await
    .expect("disable member");

    let disabled = pool
        .list(ListOptions {
            id: wallet_pool_id.clone(),
            filter: Filter {
                role: Some(WalletRole::Member),
                ..Default::default()
            },
            ..Default::default()
        })
        .await
        .expect("list after disable");
    assert!(
        disabled.iter().any(|e| e.ordinal == 1 && !e.enabled),
        "member 1 should be disabled"
    );

    // 11. Clean up.
    pool.delete(&wallet_pool_id).await.expect("delete pool");
}
