//! Testnet end-to-end lifecycle test for wallet-pool.
//!
//! This test is gated by the `WALLET_POOL_TESTNET` environment variable so that
//! normal CI runs without testnet access stay green. When enabled it exercises
//! the full pool lifecycle against the Sui testnet faucet and RPC.
//!
//! Run manually with:
//!
//! ```bash
//! WALLET_POOL_TESTNET=1 \
//! SUI_RPC_URL=https://fullnode.testnet.sui.io:443 \
//! SUI_FAUCET_URL=https://faucet.testnet.sui.io \
//! cargo test -p wallet-pool --test testnet_e2e -- --nocapture
//! ```

use std::sync::Arc;
use std::time::Duration;
use tokio::time::{sleep, timeout};
use wallet_pool::{
    BalanceOptions, By, CacheMode, CreateOptions, FundOptions, ListOptions, OpenOptions,
    SignAndExecuteOptions, WalletPool,
};
use wallet_pool::rpc::{ReqwestRpc, SuiRpc};
use wallet_pool::store::FileWalletPoolStore;
use wallet_pool_core::blob::{Network, WalletRole};

const DEFAULT_SUI_RPC_URL: &str = "https://fullnode.testnet.sui.io:443";
const DEFAULT_FAUCET_URL: &str = "https://faucet.testnet.sui.io";
const SUI_COIN_TYPE: &str = "0x2::sui::SUI";
const FUND_AMOUNT: u64 = 100_000_000; // 0.1 SUI per member
const TRANSFER_AMOUNT: u64 = 1; // 1 MIST
const TEST_TIMEOUT: Duration = Duration::from_secs(300);

#[tokio::test]
async fn full_lifecycle_on_testnet() {
    if std::env::var("WALLET_POOL_TESTNET").is_err() {
        return;
    }

    timeout(TEST_TIMEOUT, run_full_lifecycle())
        .await
        .expect("testnet e2e timed out");
}

async fn run_full_lifecycle() {
    let rpc_url = std::env::var("SUI_RPC_URL").unwrap_or_else(|_| DEFAULT_SUI_RPC_URL.into());
    let faucet_url = std::env::var("SUI_FAUCET_URL").unwrap_or_else(|_| DEFAULT_FAUCET_URL.into());

    let dir = tempfile::tempdir().expect("temp dir");
    let store = Arc::new(FileWalletPoolStore::new(dir.path()));
    let rpc = Arc::new(ReqwestRpc::new(&rpc_url).with_faucet_url(&faucet_url));
    let pool = WalletPool::new(store, rpc.clone());

    // Create a pool with 2 members on testnet.
    let created = pool
        .create(CreateOptions {
            network: Network::Testnet,
            member_count: 2,
            ..Default::default()
        })
        .await
        .expect("create pool");

    // Read the public index to obtain entry addresses before opening.
    let entries = pool
        .list(ListOptions {
            id: created.wallet_pool_id.clone(),
            ..Default::default()
        })
        .await
        .expect("list pool entries");
    assert_eq!(entries.len(), 3, "expected master + 2 members");

    let master_address = entries
        .iter()
        .find(|e| e.role == WalletRole::Master)
        .expect("master entry")
        .address
        .clone();
    let member_addresses: Vec<String> = entries
        .iter()
        .filter(|e| e.role == WalletRole::Member)
        .map(|e| e.address.clone())
        .collect();
    assert_eq!(member_addresses.len(), 2);
    let member1_address = member_addresses[0].clone();
    let member2_address = member_addresses[1].clone();

    // Open the pool so decrypted keys are available in memory.
    let mut handle = pool
        .open(OpenOptions {
            id: created.wallet_pool_id.clone(),
            access_value: created.access_value.clone(),
            network: Network::Testnet,
            cache_mode: CacheMode::Default,
        })
        .await
        .expect("open pool");

    // Request SUI from the faucet for the master address.
    let mut faucet_ok = false;
    for attempt in 0..5 {
        match rpc.faucet_request(&master_address).await {
            Ok(()) => {
                faucet_ok = true;
                break;
            }
            Err(e) => {
                eprintln!("faucet request attempt {attempt} failed: {e}");
                sleep(Duration::from_secs(5)).await;
            }
        }
    }
    assert!(faucet_ok, "faucet request failed after retries");

    // Wait and check that the master received enough SUI to fund members.
    let required_master_balance = FUND_AMOUNT * 2 + 60_000_000; // gas + buffer
    let mut master_balance = 0;
    for attempt in 0..60 {
        match rpc.get_all_balances(&master_address).await {
            Ok(balances) => {
                if let Some(sui) = balances.iter().find(|b| b.coin_type == SUI_COIN_TYPE) {
                    if sui.total_balance >= required_master_balance {
                        master_balance = sui.total_balance;
                        break;
                    }
                }
            }
            Err(e) => eprintln!("balance check attempt {attempt} failed: {e}"),
        }
        sleep(Duration::from_secs(2)).await;
    }
    assert!(
        master_balance >= required_master_balance,
        "master balance did not arrive in time: {master_balance}"
    );

    // Fund members with SUI.
    let fund_digest = handle
        .fund(FundOptions {
            coin_type: Some(SUI_COIN_TYPE.into()),
            amount_per_recipient: FUND_AMOUNT,
            recipients: vec![member1_address.clone(), member2_address.clone()],
            await_effects: true,
        })
        .await
        .expect("fund members");
    eprintln!("fund transaction digest: {fund_digest}");

    // Wait for members to receive the funded coins.
    for member_address in [&member1_address, &member2_address] {
        let mut found = false;
        for attempt in 0..30 {
            match rpc.get_all_balances(member_address).await {
                Ok(balances) => {
                    if let Some(sui) = balances.iter().find(|b| b.coin_type == SUI_COIN_TYPE) {
                        if sui.total_balance >= FUND_AMOUNT {
                            found = true;
                            break;
                        }
                    }
                }
                Err(e) => eprintln!("member balance check attempt {attempt} failed: {e}"),
            }
            sleep(Duration::from_secs(2)).await;
        }
        assert!(
            found,
            "member {member_address} did not receive funded SUI in time"
        );
    }

    // Get member key for ordinal 1.
    let member_key = handle
        .get_member_key(By::Ordinal(1))
        .expect("get member key");
    let signing_address = wallet_pool_core::crypto::ed25519_address(&member_key.public_key());
    assert_eq!(
        signing_address, member1_address,
        "member key address mismatch"
    );

    // Build a simple transfer PTB that sends 1 MIST back to the master.
    // The member's gas coin is split and the resulting coin is transferred.
    let master_addr = sui_sdk_types::Address::from_hex(&master_address).expect("master address parse");
    let amount_bytes = bcs::to_bytes(&TRANSFER_AMOUNT).expect("serialize amount");
    let master_addr_bytes = bcs::to_bytes(&master_addr).expect("serialize master address");

    let ptb = sui_sdk_types::ProgrammableTransaction {
        inputs: vec![
            sui_sdk_types::Input::Pure(amount_bytes),
            sui_sdk_types::Input::Pure(master_addr_bytes),
        ],
        commands: vec![
            sui_sdk_types::Command::SplitCoins(sui_sdk_types::SplitCoins {
                coin: sui_sdk_types::Argument::Gas,
                amounts: vec![sui_sdk_types::Argument::Input(0)],
            }),
            sui_sdk_types::Command::TransferObjects(sui_sdk_types::TransferObjects {
                objects: vec![sui_sdk_types::Argument::NestedResult(0, 0)],
                address: sui_sdk_types::Argument::Input(1),
            }),
        ],
    };

    let transfer_digest = handle
        .sign_and_execute(SignAndExecuteOptions {
            by: By::Ordinal(1),
            ptb,
            await_effects: true,
        })
        .await
        .expect("sign and execute transfer");
    eprintln!("transfer transaction digest: {transfer_digest}");

    // List live balances for all pool entries.
    let entries = pool
        .list(ListOptions {
            id: created.wallet_pool_id.clone(),
            live_balances: true,
            ..Default::default()
        })
        .await
        .expect("list live balances");
    assert_eq!(entries.len(), 3, "expected master + 2 members");

    // Verify view_balance also returns data.
    let balances = pool
        .view_balance(BalanceOptions {
            id: created.wallet_pool_id.clone(),
            address: Some(member1_address.clone()),
        })
        .await
        .expect("view member balance");
    assert!(
        balances.contains_key(&member1_address),
        "member balance missing"
    );

    // Export the pool, delete it, and re-import.
    let exported = pool
        .export(&created.wallet_pool_id)
        .await
        .expect("export pool");
    pool.delete(&created.wallet_pool_id)
        .await
        .expect("delete pool");
    assert!(
        pool.export(&created.wallet_pool_id).await.is_err(),
        "pool should be deleted"
    );

    let imported_id = pool.import(&exported).await.expect("import pool");
    assert_eq!(
        imported_id, created.wallet_pool_id,
        "imported pool id mismatch"
    );

    let summaries = pool.list_pools().await.expect("list pools");
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].wallet_pool_id, created.wallet_pool_id);

    handle.close();
}
