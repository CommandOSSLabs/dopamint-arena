# Using the wallet-pool Rust library

Operate a pool of Sui wallets managed by the `wallet-pool` Rust crate.

## Before you begin

1. Decide which Sui network to target (`testnet` is used below; `mainnet` works the same).
2. Make sure you have SUI to fund the pool master. The easiest path is a `sui` CLI client with a funded active address:
   ```bash
   sui client switch --env testnet
   sui client gas
   ```
3. Set the RPC URL for the target network:
   ```bash
   export SUI_RPC_URL=https://fullnode.testnet.sui.io:443
   ```

## Required tooling

- Rust toolchain (see root `.nvmrc` for Node; Rust version pinned by `rust-toolchain.toml`)
- `sui` CLI with a funded active address and keystore
- `cargo`

## Build the crates

```bash
cargo build -p wallet-pool -p wallet-pool-core
```

Run the unit tests:

```bash
cargo test -p wallet-pool -p wallet-pool-core
```

## Run the end-to-end example

The fastest way to see every feature exercised on a live network is the included example:

```bash
sui client switch --env testnet
export SUI_RPC_URL=https://fullnode.testnet.sui.io:443
cargo run -p wallet-pool --example full_demo
```

The example:

1. Creates a pool of 50 wallets.
2. Transfers 0.5 SUI from the CLI active address into the pool master.
3. Funds all 50 members from the master.
4. Signs and executes a member → master transfer.
5. Lists, filters, and queries live balances.
6. Demonstrates `pick`, `next`, and `lru` selection helpers.
7. Exports, imports, disables, re-enables, and deletes the pool.

## Basic library usage

### 1. Create and open a pool

```rust
use std::sync::Arc;
use wallet_pool::{
    CacheMode, CreateOptions, Network, OpenOptions, ReqwestRpc, WalletPool,
};
use wallet_pool::rpc::SuiRpc;
use wallet_pool::store::FileWalletPoolStore;

let rpc: Arc<dyn SuiRpc> = Arc::new(ReqwestRpc::new("https://fullnode.testnet.sui.io:443"));
let store = Arc::new(FileWalletPoolStore::new("/tmp/wallet-pool"));
let pool = WalletPool::new(store, rpc);

let created = pool
    .create(CreateOptions {
        network: Network::Testnet,
        member_count: 50,
        ..Default::default()
    })
    .await?;

let mut handle = pool
    .open(OpenOptions {
        id: created.wallet_pool_id.clone(),
        access_value: created.access_value.clone(),
        network: created.network,
        cache_mode: CacheMode::Default,
    })
    .await?;
```

Keep the `access_value` secret. It is the only thing that decrypts the member keys.

### 2. Fund the pool master

The library does not hold a keystore, so seed the master address from an external source such as the `sui` CLI. Derive the master address from the opened handle:

```rust
use wallet_pool::By;
use wallet_pool_core::crypto::ed25519_address;

let master_key = handle.get_member_key(By::Ordinal(0))?;
let master_address = ed25519_address(&master_key.public_key());
println!("{master_address}");
```

Then transfer SUI to it:

```bash
sui client transfer-sui \
  --to <master_address> \
  --sui-coin-object-id <your_gas_coin> \
  --amount 500000000 \
  --gas-budget 5000000
```

### 3. Fund members from the master

```rust
use wallet_pool::{FundOptions, WalletRole};

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
let digest = handle
    .fund(FundOptions {
        coin_type: Some("0x2::sui::SUI".into()),
        amount_per_recipient: 1_000_000,
        recipients,
        await_effects: true,
    })
    .await?;
```

#### Funding with non-SUI tokens

`fund` accepts any fully-qualified coin type. The transaction fee is still paid in SUI, and if the master holds several small coins of the target type they are merged automatically before splitting.

```rust
let digest = handle
    .fund(FundOptions {
        coin_type: Some("0x5d4b302506645c37ff133b98c13b0012de9d11ff5cbac74af62a8c1c90e0b0a2::usdc::USDC".into()),
        amount_per_recipient: 1_000_000,
        recipients,
        await_effects: true,
    })
    .await?;
```

Requirements for non-SUI funding:

- The master must own enough of the target coin to cover `amount_per_recipient * recipients.len()`.
- The master must also own enough SUI to pay the gas budget (currently 50 MIST).
- If no single coin is large enough, the library merges a prefix of the master's coins of that type before splitting.

### 4. Sign and execute a transaction as a member

```rust
use sui_sdk_types::Address;
use sui_transaction_builder::{ObjectInput, TransactionBuilder};
use wallet_pool::{By, SignAndExecuteOptions};

let member_key = handle.get_member_key(By::Ordinal(1))?;
let member_address = ed25519_address(&member_key.public_key());
let sender = Address::from_hex(&member_address)?;
let recipient = Address::from_hex(&master_address)?;

let coins = rpc.get_coins(&member_address, "0x2::sui::SUI").await?;
let coin = &coins[0];
let object_id = Address::from_hex(&coin.object_id)?;
let digest = sui_sdk_types::Digest::from_base58(&coin.digest)?;

let mut tx = TransactionBuilder::new();
tx.set_sender(sender);
tx.set_gas_budget(50_000_000);
tx.set_gas_price(1_000);
tx.add_gas_objects([ObjectInput::owned(object_id, coin.version, digest)]);
let coin_arg = tx.gas();
let recipient_arg = tx.pure(&recipient);
tx.transfer_objects(vec![coin_arg], recipient_arg);

let transaction = tx.try_build()?;
let ptb = match transaction.kind {
    sui_sdk_types::TransactionKind::ProgrammableTransaction(ptb) => ptb,
    _ => panic!("expected PTB"),
};

let digest = handle
    .sign_and_execute(SignAndExecuteOptions {
        by: By::Ordinal(1),
        ptb,
        await_effects: true,
    })
    .await?;
```

### 5. List and filter entries

```rust
use wallet_pool::{Filter, ListOptions, WalletRole};

let funded_members = pool
    .list(ListOptions {
        id: pool_id.clone(),
        filter: Filter {
            role: Some(WalletRole::Member),
            coin_type: Some("0x2::sui::SUI".into()),
            balance_min: Some(1),
            ..Default::default()
        },
        live_balances: true,
        ..Default::default()
    })
    .await?;
```

### 6. Use selection helpers

```rust
use wallet_pool_core::filter::Filter;
use wallet_pool_core::select;

let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)?
    .as_millis() as u64;

let first = select::pick(&members, &Filter::default(), &None, now);
let mut cursor = 0;
let next = select::next(&members, &Filter::default(), &None, now, &mut cursor);
let lru = select::lru(&members, &Filter::default(), &None, now);
```

### 7. Export, import, disable, and delete

```rust
// Export the encrypted pool blob.
let bytes = pool.export(&pool_id).await?;

// Import it under its own pool id.
let imported_id = pool.import(&bytes).await?;
assert_eq!(imported_id, pool_id);

// Disable a member.
pool.set_enabled(SetEnabledOptions {
    id: pool_id.clone(),
    by: By::Ordinal(1),
    enabled: false,
})
.await?;

// Delete the pool.
pool.delete(&pool_id).await?;
```

## Security notes

- The `access_value` decrypts every member key. Treat it like a seed phrase: store it in a secrets manager, never commit it, and never log it.
- `WalletPoolHandle` keeps decrypted keys in an in-memory LRU cache. Call `handle.wipe()` or `handle.close()` when the handle is no longer needed.
- `CacheMode::None` avoids pre-warming the cache if you want keys decrypted only on demand.
- Pool blobs are written with owner-only permissions by `FileWalletPoolStore`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `InsufficientFunds` when funding | Master coin balance < total + 50 MIST gas budget | Send more SUI to the master address, or reduce `amount_per_recipient` / recipient count. |
| `InsufficientFunds` when signing | Member gas coin < 50 MIST gas budget | Fund the signing member with at least ~60 MIST, or use a member that received more. |
| `NetworkMismatch` on open | `OpenOptions.network` does not match the stored blob | Open with the same `Network` used at creation time. |
| `WrongAccessValueError` on open | Incorrect access value | Use the exact value returned by `create`. |
| `sui client transfer-sui` fails | Active env points to wrong network | `sui client switch --env testnet` (or `mainnet`). |
