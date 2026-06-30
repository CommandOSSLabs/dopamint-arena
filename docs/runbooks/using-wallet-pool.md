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
2. Transfers 1 SUI from the CLI active address into the pool master.
3. Funds all 50 members from the master.
4. Signs and executes a member → master transfer.
5. Lists, filters, and queries live balances.
6. Demonstrates `pick`, `next`, and `lru` selection helpers.
7. Exports, imports, disables, re-enables, and deletes the pool.

### Run the arbitrary-token (BUCK) example

There is also a demo that funds the pool with a non-SUI token:

```bash
sui client switch --env testnet
export SUI_RPC_URL=https://fullnode.testnet.sui.io:443
export BUCK_OBJECT_ID=<a_buck_coin_owned_by_your_active_address>
cargo run -p wallet-pool --example full_demo_buck
```

The BUCK example does everything the SUI example does, but:

- It funds the master with 1 BUCK plus 1 SUI for gas.
- It funds all members with BUCK.
- It funds the signing member with SUI for gas.
- It signs and executes a BUCK transfer from member → master.

To find a token's fully-qualified coin type, inspect the object with `sui client objects --json` and look for `"Coin": { "struct": { "address", "module", "name" } }`. For BUCK it is:

```text
0x52fa24986ed45532b871326114454b711f99c7f7c57294a28d82cedc1fc78a70::test_buck::TEST_BUCK
```

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

Then transfer SUI to it for gas:

```bash
sui client transfer-sui \
  --to <master_address> \
  --sui-coin-object-id <your_gas_coin> \
  --amount 1000000000 \
  --gas-budget 5000000
```

If you are funding members with a non-SUI token, also send the token to the master. For a `Coin<T>` object:

```bash
sui client pay \
  --input-coins <token_object_id> \
  --recipients <master_address> \
  --amounts <amount_in_smallest_unit> \
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
- The master must also own enough SUI to pay the gas budget (currently 200 MIST).
- If no single coin is large enough, the library merges a prefix of the master's coins of that type before splitting.
- Members that will sign transactions need their own SUI coins for gas.

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

#### Signing a non-SUI token transfer

The member pays gas in SUI, but transfers a different coin object:

```rust
let gas_coins = rpc.get_coins(&member_address, "0x2::sui::SUI").await?;
let gas_coin = &gas_coins[0];
let token_coins = rpc.get_coins(&member_address, "0x52fa24986ed45532b871326114454b711f99c7f7c57294a28d82cedc1fc78a70::test_buck::TEST_BUCK").await?;
let token_coin = &token_coins[0];

let gas_id = Address::from_hex(&gas_coin.object_id)?;
let gas_digest = sui_sdk_types::Digest::from_base58(&gas_coin.digest)?;
let token_id = Address::from_hex(&token_coin.object_id)?;
let token_digest = sui_sdk_types::Digest::from_base58(&token_coin.digest)?;

let mut tx = TransactionBuilder::new();
tx.set_sender(sender);
tx.set_gas_budget(50_000_000);
tx.set_gas_price(1_000);
tx.add_gas_objects([ObjectInput::owned(gas_id, gas_coin.version, gas_digest)]);

let token_arg = tx.object(ObjectInput::owned(token_id, token_coin.version, token_digest));
let recipient_arg = tx.pure(&recipient);
tx.transfer_objects(vec![token_arg], recipient_arg);

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

## Online pool (S3 storage)

The offline pool writes blobs to a local directory. The **online** pool is
identical in every feature — it stores the same encrypted blobs in an Amazon S3
bucket so any caller with AWS credentials can reach a shared pool from any
machine. Only the storage location differs; every operation (create, open, fund,
sign, list, export/import, disable, delete) is unchanged.

Build the crate:

```bash
cargo build -p wallet-pool-s3
```

### Environment variables

`S3WalletPoolStore::from_env()` reads its config from the environment. What you
need depends on whether you **operate** a pool (create/fund it) or just **use**
one that already exists.

**Storage — AWS / S3 (required by everyone):**

| Variable | Required? | Purpose |
|----------|-----------|---------|
| `WALLET_POOL_S3_BUCKET` | yes | Bucket holding the pool blobs, e.g. `dev-env-dopamint-wallet-pool`. |
| `AWS_ACCESS_KEY_ID` | yes | Access key id of an IAM user allowed to read/write the bucket. |
| `AWS_SECRET_ACCESS_KEY` | yes | Secret access key for that IAM user. |
| `AWS_REGION` | yes | Region the bucket lives in, e.g. `us-east-1`. |
| `WALLET_POOL_S3_PREFIX` | no | Key prefix to namespace pools (default empty = flat layout, `{id}.json`). |

The AWS SDK default credential chain resolves the keys, so any standard mechanism
works: static env vars (above), a `~/.aws/credentials` profile, or an IAM role
when hosted on EC2/ECS/Lambda. Scope the IAM policy to this one bucket only
(`s3:ListBucket` + `s3:GetObject`/`PutObject`/`DeleteObject` on `…/*`).

**Sui network (required by everyone):**

| Variable | Required? | Purpose |
|----------|-----------|---------|
| `SUI_RPC_URL` | yes | Fullnode RPC URL, e.g. `https://fullnode.testnet.sui.io:443`. Passed to `ReqwestRpc`; not read by the store itself. |

**Pool identity (required only to open an existing pool — obtained from whoever created it):**

| Item | Required? | Purpose |
|------|-----------|---------|
| Pool id (`wp_…`) | yes | Identifies the pool's object key in the bucket. |
| `access_value` | yes | Decrypts every member key. Treat it like a seed phrase. |
| Network | yes | The network the pool was created on (`Testnet` / `Mainnet`). |

> Operators (who create pools) additionally need the `sui` CLI with a funded
> active address, to seed the master with SUI for gas and with the distribution
> token. See the offline sections above for the funding commands.

### Use an existing online pool (consumer)

A consumer needs **only** the storage + Sui env vars and the pool id /
`access_value` from the operator — no `sui` CLI, no funds:

```bash
export AWS_ACCESS_KEY_ID=…
export AWS_SECRET_ACCESS_KEY=…
export AWS_REGION=us-east-1
export WALLET_POOL_S3_BUCKET=dev-env-dopamint-wallet-pool
export SUI_RPC_URL=https://fullnode.testnet.sui.io:443
```

```rust
use std::sync::Arc;
use wallet_pool::rpc::{ReqwestRpc, SuiRpc};
use wallet_pool::{CacheMode, Network, OpenOptions, WalletPool};
use wallet_pool_s3::S3WalletPoolStore;

let rpc = Arc::new(ReqwestRpc::new(&std::env::var("SUI_RPC_URL").unwrap()));
let store = Arc::new(S3WalletPoolStore::from_env().await?);
let pool = WalletPool::new(store, rpc);

// pool id + access_value come from the pool's creator
let mut handle = pool
    .open(OpenOptions {
        id: "wp_…".into(),
        access_value: "…".into(),
        network: Network::Testnet,
        cache_mode: CacheMode::Default,
    })
    .await?;

// Now use it: sign transactions as a member, list entries, read live balances,
// export, disable members, etc. — exactly as in the offline sections above.
handle.close(); // wipes decrypted keys from memory when done
```

### Create and fund a new online pool (operator)

The operator provisions the bucket + scoped IAM user, then creates and funds the
pool exactly like the offline flow — only the store differs. They then share the
**pool id** and **access_value** with consumers.

```rust
use std::sync::Arc;
use wallet_pool::rpc::ReqwestRpc;
use wallet_pool::{CreateOptions, Network, WalletPool};
use wallet_pool_s3::S3WalletPoolStore;

let rpc = Arc::new(ReqwestRpc::new("https://fullnode.testnet.sui.io:443"));
let store = Arc::new(S3WalletPoolStore::from_env().await?);
let pool = WalletPool::new(store, rpc);

let created = pool
    .create(CreateOptions {
        network: Network::Testnet,
        member_count: 50,
        ..Default::default()
    })
    .await?;
// created.wallet_pool_id  -> share with consumers
// created.access_value    -> share securely; it decrypts every member key
```

Fund the master with SUI (gas) and the distribution token via the `sui` CLI, then
fund members with `handle.fund(...)` — identical to the offline sections above.

### Run the end-to-end demo over S3

A quick store-only round-trip (no Sui network needed):

```bash
cargo run -p wallet-pool-s3 --example s3_demo
```

The **full** end-to-end lifecycle over S3 — create a 50-member pool in the
bucket, fund the master with 1 BUCK + 1 SUI, fund all members, sign a
member→master BUCK transfer, list/filter/query balances, exercise selection
helpers, export/import (through S3), disable and re-enable a member, and delete —
is in `s3_full_demo_buck`:

```bash
sui client switch --env testnet
export SUI_RPC_URL=https://fullnode.testnet.sui.io:443
export BUCK_OBJECT_ID=<a_buck_coin_owned_by_your_active_address>
export AWS_ACCESS_KEY_ID=…
export AWS_SECRET_ACCESS_KEY=…
export AWS_REGION=us-east-1
export WALLET_POOL_S3_BUCKET=dev-env-dopamint-wallet-pool
cargo run -p wallet-pool-s3 --example s3_full_demo_buck
```

The demo asserts the blob is present in the bucket after create and gone after
delete, proving the pool really lives in S3.

### Security and concurrency

- Blobs are AES-256-GCM encrypted via the pool `access_value`, so the wallet keys
  stay safe even if the bucket is compromised. A leaked AWS key still exposes the
  plaintext address index and the ability to overwrite/corrupt blobs — scope the
  IAM policy to the bucket and rotate keys if needed.
- Writes are last-writer-wins, same as the file store: if two processes mutate
  the same pool at once, one overwrites the other. Bucket versioning (on for
  `dev-env-dopamint-wallet-pool`) is the rollback safety net. Safe concurrent
  mutation via S3 conditional writes is not yet wired.

## Security notes

- The `access_value` decrypts every member key. Treat it like a seed phrase: store it in a secrets manager, never commit it, and never log it.
- `WalletPoolHandle` keeps decrypted keys in an in-memory LRU cache. Call `handle.wipe()` or `handle.close()` when the handle is no longer needed.
- `CacheMode::None` avoids pre-warming the cache if you want keys decrypted only on demand.
- Pool blobs are written with owner-only permissions by `FileWalletPoolStore`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `InsufficientFunds` when funding | Master coin balance < total + 200 MIST gas budget | Send more SUI to the master address, or reduce `amount_per_recipient` / recipient count. |
| `InsufficientFunds` when signing | Member gas coin < 50 MIST gas budget | Fund the signing member with at least ~60 MIST, or use a member that received more. |
| `InsufficientFunds` when funding a token | Master has the token but not enough SUI for gas | Send SUI to the master address; gas is always paid in SUI. |
| `NetworkMismatch` on open | `OpenOptions.network` does not match the stored blob | Open with the same `Network` used at creation time. |
| `WrongAccessValueError` on open | Incorrect access value | Use the exact value returned by `create`. |
| `sui client transfer-sui` fails | Active env points to wrong network | `sui client switch --env testnet` (or `mainnet`). |
| `InvalidInput: WALLET_POOL_S3_BUCKET not set` | `S3WalletPoolStore::from_env()` called without the env var | `export WALLET_POOL_S3_BUCKET=…` (see [Online pool](#online-pool-s3-storage)). |
| S3 `AccessDenied` / `store error: s3 …` | IAM policy missing the action, or wrong bucket/region | Confirm the IAM user may `s3:Get/Put/Delete/ListBucket` on the exact bucket and `AWS_REGION` matches the bucket's region. |
