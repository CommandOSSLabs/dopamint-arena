# wallet-pool — Rust rewrite design spec

- **Date:** 2026-06-29
- **Status:** Draft (awaiting user review)
- **Branch:** `pool-wallet-rust`
- **Scope:** Replace the TypeScript `wallet-pool/` package with a Rust implementation that exposes the same sealed-pool semantics and is byte-compatible with the existing blob format.

## 1. Context

The TypeScript `wallet-pool` working spec (`docs/superpowers/specs/2026-06-29-wallet-pool-design.md`) defines a sealed, portable pool of Sui accounts: a public plaintext index plus an AES-256-GCM encrypted payload of secret keys, unlocked by a `wallet-pool-access` value. That document is the input to this Rust rewrite, not a mandatory checklist; where Rust idioms or the existing repo toolchain suggest a different shape, this spec takes precedence.

## 2. Locked decisions

| Area | Decision |
|---|---|
| Location | Replace `wallet-pool/` with Rust; delete TypeScript code. |
| Crate structure | Split crate: `wallet-pool-core` (sync, sans-IO) + `wallet-pool` (async shell). |
| Runtime | Async library on `tokio`; sync hot path inside the core crate. |
| Sui stack | Use workspace `sui-sdk-types`, `sui-transaction-builder`, `sui-crypto` (lightweight crates.io path). |
| Blob format | Keep the existing JSON blob format so Rust and TS pools are mutually readable. |
| Feature scope | Full spec feature set: create, fund, get_member_key, sign_and_execute, list/filter, selection helpers, export/import, key cache. |
| Test target | Testnet + faucet for integration/E2E; local unit tests for everything else. |

## 3. Crate layout

```
wallet-pool/
├── Cargo.toml          # package manifest for the async crate
├── src/                # async crate sources
│   ├── lib.rs
│   ├── client.rs
│   ├── store.rs
│   ├── rpc.rs
│   ├── fund.rs
│   ├── sign.rs
│   ├── key_cache.rs
│   └── error.rs
└── core/               # sync sans-IO crate
    ├── Cargo.toml
    └── src/
        ├── lib.rs
        ├── crypto.rs
        ├── envelope.rs
        ├── blob.rs
        ├── filter.rs
        ├── select.rs
        └── error.rs
```

Root `Cargo.toml` adds `"wallet-pool"` and `"wallet-pool/core"` to `[workspace] members`. The `core/` directory is a sibling package inside `wallet-pool/`, not a nested Cargo workspace.

## 4. `wallet-pool/core` (sync, sans-IO)

Package name: `wallet-pool-core`. Rust identifiers refer to it as `wallet_pool_core`.

### 4.1 `crypto`

- `KeyPair` — 32-byte ed25519 secret seed + 32-byte public key.
- `generate_keypair() -> KeyPair`.
- `keypair_from_secret([u8; 32]) -> KeyPair`.
- `ed25519_address([u8; 32]) -> SuiAddress` — `0x || blake2b256(0x00 || pubkey)`.
- `random_bytes(n) -> Vec<u8>` via `getrandom`.

Uses `ed25519-dalek` and `blake2`, matching the existing `rust/engine/tunnel-core/src/crypto.rs` golden vectors.

### 4.2 `envelope`

`SealedEnvelope` matches the TS JSON shape exactly:

```rust
pub struct SealedEnvelope {
    pub mode: AccessMode,        // "generated" | "passphrase"
    pub kdf: Option<ScryptKdf>,  // present only for passphrase
    pub nonce: String,           // base64, 12-byte AES-GCM nonce
    pub tag: String,             // base64, 16-byte auth tag
    pub ciphertext: String,      // base64
}
```

- **Generated mode:** base64url-decode the access value to 32 bytes, run `HKDF-SHA256` with empty salt/info to get the AES key.
- **Passphrase mode:** `scrypt(passphrase, salt, N=16384, r=8, p=1)` → 32-byte AES key.
- **AEAD:** AES-256-GCM via `aes_gcm` crate, random 12-byte nonce, 16-byte tag.
- `seal(plaintext, access_value, mode, aad) -> SealedEnvelope`.
- `unseal(envelope, access_value, aad) -> Result<Vec<u8>, WrongAccessValueError>`.

Wrong access value must produce only `WrongAccessValueError`; no information about which check failed.

### 4.3 `blob`

`PoolBlob` is the TS JSON structure:

```rust
pub struct PoolBlob {
    pub version: u32,              // 1
    pub wallet_pool_id: String,    // "wp_..."
    pub network: Network,          // mainnet | testnet
    pub label: Option<String>,
    pub created_at: u64,
    pub coin_types: Vec<String>,
    pub crypto: SealedEnvelope,
    pub index: Vec<WalletEntry>,
}
```

`WalletEntry` carries role, address, ordinal, label, enabled, use stats, and funded amounts — no secrets.

`SealedMembers` (plaintext inside the ciphertext):

```rust
pub struct SealedMembers {
    pub master_secret: [u8; 32],
    pub members: Vec<MemberSecret>,
}

pub struct MemberSecret {
    pub ordinal: u32,
    pub secret: [u8; 32],
}
```

- `serialize_blob(&PoolBlob) -> Vec<u8>` — JSON, pretty-printed to match TS.
- `parse_blob(&[u8]) -> Result<PoolBlob, BlobError>`.
- `aad_for(&PoolBlob) -> Vec<u8>` — `wallet-pool:{version}:{wallet_pool_id}:{network}`.

AAD binds only immutable identity fields (`version`, `wallet_pool_id`, `network`) so the mutable `index` can be updated without re-sealing.

### 4.4 `filter` and `select`

`filter` exposes a predicate DSL over `&[WalletEntry]` plus an optional balance map:

- role, address exact/prefix/suffix, ordinal range, label.
- coin/balance: `holds_coin`, `balance { gte, lte, eq }`, `total_balance_gte`, `sufficient_for_gas`, `nonzero`.
- funding: `funded`, `unfunded`, `funded_amount_gte`, `last_funded_at` range.
- availability: `idle_for_ms`, `use_count`.
- health: `enabled`, `exists`.

`select` provides:

- `pick` — any single match.
- `next` — round-robin cursor; cursor is persisted in the public index on explicit `sync`.
- `random` — random match (seeded RNG in tests).
- `lru` — least-recently-used match.

Cross-process leasing is out of scope; `next` is best-effort single-process.

### 4.5 `error`

Core error enum:

```rust
pub enum Error {
    WrongAccessValue,
    InvalidInput(String),
    InvalidBlob(String),
    NetworkMismatch { expected: Network, got: Network },
    AccountDisabled { address: String },
    MemberNotFound { by: String },
    MasterNotRetrievable,
}
```

## 5. `wallet-pool` package (async shell)

### 5.1 `store`

```rust
#[async_trait]
pub trait WalletPoolStore: Send + Sync {
    async fn read(&self, id: &str) -> Result<Option<Vec<u8>>, StoreError>;
    async fn write(&self, id: &str, bytes: &[u8]) -> Result<(), StoreError>;
    async fn list(&self) -> Result<Vec<String>, StoreError>;
    async fn delete(&self, id: &str) -> Result<(), StoreError>;
}
```

`FileWalletPoolStore` writes to `~/.wallet-pool/<id>.json` with `0o700` directory and `0o600` files, matching the TS precedent.

### 5.2 `rpc`

`SuiRpc` wraps `reqwest::Client` and exposes:

- `get_all_balances(address) -> Vec<Balance>`.
- `get_coins(owner, coin_type) -> Vec<Coin>`.
- `execute_transaction(tx_bytes, signatures) -> TransactionResponse`.
- `wait_for_transaction(digest) -> Result<(), RpcError>`.
- `faucet_request(address) -> Result<(), FaucetError>` (testnet).

Keeps HTTP connection pooling. Balance results are cached with a TTL (default 5 s).

### 5.3 `fund`

Builds a single PTB per call:

1. Resolve target addresses (all members or explicit list).
2. Fetch master `Coin<T>` objects for the requested coin type.
3. `splitCoins(master_coin, amounts)`.
4. `transferObjects(split_coins, recipients)`.
5. Sign with master, execute, optionally wait for effects.
6. Update `last_funded_at` / `funded_amounts` for affected members and persist the blob.

`coin_type` defaults to `0x2::sui::SUI`.

### 5.4 `sign`

`sign_and_execute(member, ptb)`:

1. Resolve member by address or ordinal.
2. Check `enabled`.
3. Get decrypted `KeyPair` (cache hit or decrypt).
4. Sign the caller-supplied PTB.
5. Submit via RPC.
6. Update `use_count` / `last_used_at` and persist blob.

### 5.5 `key_cache`

In-process LRU + TTL cache for decrypted `KeyPair`s:

- Default max 256 entries, TTL 60 s.
- Pre-warmed by `open()`.
- `wipe()` / `close()` clears the cache.
- `CacheMode::Default` or `CacheMode::None` (per-call decrypt).

AEAD key cache: in passphrase mode, the scrypt-derived key is cached per session so scrypt runs once.

### 5.6 `client`

Main facade:

```rust
pub struct WalletPool {
    store: Arc<dyn WalletPoolStore>,
    rpc: Arc<SuiRpc>,
}

impl WalletPool {
    pub async fn create(&self, opts: CreateOptions) -> Result<CreateResult, Error>;
    pub async fn open(&self, opts: OpenOptions) -> Result<WalletPoolHandle, Error>;
    pub async fn list(&self, opts: ListOptions) -> Result<ListResult, Error>;
    pub async fn view_balance(&self, opts: BalanceOptions) -> Result<BalanceMap, Error>;
    pub async fn set_enabled(&self, opts: SetEnabledOptions) -> Result<(), Error>;
    pub async fn export(&self, id: &str) -> Result<Vec<u8>, Error>;
    pub async fn import(&self, blob: &[u8]) -> Result<String, Error>;
    pub async fn delete(&self, id: &str) -> Result<(), Error>;
    pub async fn list_pools(&self) -> Result<Vec<PoolSummary>, Error>;
}

pub struct WalletPoolHandle {
    blob: PoolBlob,
    members: SealedMembers,
    store: Arc<dyn WalletPoolStore>,
    rpc: Arc<SuiRpc>,
    key_cache: KeyCache<KeyPair>,
}

impl WalletPoolHandle {
    pub fn get_member_key(&self, by: By) -> Result<KeyPair, Error>;
    pub async fn sign_and_execute(&self, opts: SignOptions) -> Result<Digest, Error>;
    pub async fn fund(&self, opts: FundOptions) -> Result<Digest, Error>;
    pub fn wipe(&mut self);
    pub fn close(self);
}
```

`open()` decrypts the sealed payload and pre-warms member keys so the hot path (`get_member_key` and signing) is sync and in-memory.

### 5.7 `error`

Async crate error enum wraps core errors plus IO/RPC variants:

```rust
pub enum Error {
    Core(wallet_pool_core::Error),
    Store(StoreError),
    Rpc(RpcError),
    Faucet(FaucetError),
    Transaction(TransactionError),
    InsufficientFunds(String),
    InvalidInput(String),
}
```

No secret material in error messages.

## 6. Data flow summary

- **Create** — validate → generate/import keys → build index → seal → serialize → write store → return id + access.
- **Open** — read → parse → unseal → network check → build handle → pre-warm cache.
- **Fund** — master key → fetch coins → build single PTB → sign & execute → update index → persist.
- **Sign and execute** — resolve member → get keypair → sign PTB → execute → update usage → persist.
- **List / view balance** — read header → filter/sort → optionally fetch live balances for filtered set → return.
- **Index mutations** (enable/disable, usage stats, cursor) rewrite the public header JSON without re-sealing.

## 7. Performance and security trade-offs

### 7.1 Performance
- Hot key retrieval and signing are sync and in-memory after `open()`.
- Key cache is LRU + TTL, pre-warmed on open.
- AEAD key cached per session in passphrase mode.
- No file I/O on hot path.
- Balance cache TTL defaults to 5 s.
- One PTB per `fund` call.

### 7.2 Security trade-offs
- Plaintext member keys live in-process while a handle is open.
- Mitigations: bounded cache, TTL, explicit `wipe()`/`close()`, per-process only, optional `CacheMode::None`.
- File permissions are owner-only (`0o700` / `0o600`).
- AAD binds immutable identity fields only.

## 8. Testing

### 8.1 Core unit tests (`cargo test -p wallet-pool-core`)
- Crypto golden vectors matching TS outputs.
- Envelope round-trip and wrong-access rejection.
- AAD tamper detection (header/index swap fails).
- Blob serialization and TS parity.
- Filter/sort/pagination pure functions.
- Selection helpers with deterministic RNG.

### 8.2 Async unit tests (`cargo test -p wallet-pool`)
- `FileWalletPoolStore` with temp directories.
- In-memory store + mock RPC for `fund` and `sign_and_execute` shape.
- Key cache eviction and `wipe()`.

### 8.3 Integration / E2E tests
- Target: testnet + faucet (per locked decision).
- Full cycle: create → faucet to master → fund SUI to members → `get_member_key` → `sign_and_execute` → `list(live_balances)` → export → import.
- Gated by environment variables (`WALLET_POOL_TESTNET=1`, faucet URL) so CI without secrets stays green.

## 9. Dependencies

### `wallet-pool-core`
- `ed25519-dalek`, `blake2`, `getrandom`
- `aes-gcm`, `hkdf`, `scrypt`
- `serde`, `serde_json`, `base64`
- `thiserror`

### `wallet-pool`
- `wallet-pool-core` (path = "core")
- `tokio`, `reqwest`
- `sui-sdk-types`, `sui-transaction-builder`, `sui-crypto` (transaction building and chain types)
- `serde`, `serde_json`, `base64`
- `thiserror`, `async-trait`, `lru` or `moka` for cache

Note: the hot signing path uses `ed25519-dalek` directly through `wallet-pool-core`; `sui-crypto` is used for Sui-specific transaction serialization and public-key/address types where it saves code.

## 10. Open items

1. Confirm testnet faucet URL and whether integration tests run in CI or only locally.
