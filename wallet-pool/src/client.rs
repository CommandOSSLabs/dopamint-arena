//! User-facing wallet pool facade.
//!
//! [`WalletPool`] is the entry point for pool lifecycle operations: create,
//! open, list, mutate, export, import, and delete. An opened pool yields a
//! [`WalletPoolHandle`] that keeps decrypted member keys in memory and exposes
//! the synchronous hot path [`WalletPoolHandle::get_member_key`].

use crate::error::{Error, Result};
use crate::key_cache::KeyCache;
use crate::rpc::SuiRpc;
use crate::store::WalletPoolStore;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use wallet_pool_core::blob::{
    aad_for, create_blob, parse_blob, serialize_blob, MemberSecret, Network, PoolBlob,
    SealedMembers, WalletEntry, WalletRole,
};
use wallet_pool_core::crypto::{ed25519_address, keypair_from_secret, KeyPair};
use wallet_pool_core::envelope::{seal, unseal, AccessMode};
use wallet_pool_core::filter::{apply_filter, BalanceMap, Filter, Pagination, Sort, SortField};

/// How eagerly an opened pool keeps decrypted keys in memory.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CacheMode {
    /// Pre-warm the cache with every member key on open.
    #[default]
    Default,
    /// Decrypt keys on demand; the cache is not pre-warmed.
    None,
}

/// Selector used to resolve a single member within an opened pool.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum By {
    /// Select by the wallet entry's Sui address.
    Address(String),
    /// Select by the wallet entry's ordinal (master is 0, members are 1..n).
    Ordinal(u32),
}

impl By {
    fn describe(&self) -> String {
        match self {
            By::Address(a) => format!("address={a}"),
            By::Ordinal(o) => format!("ordinal={o}"),
        }
    }
}

/// Options for creating a new wallet pool.
#[derive(Clone, Debug)]
pub struct CreateOptions {
    /// Network the pool is bound to.
    pub network: Network,
    /// Number of member wallets to generate (not counting the master).
    pub member_count: u32,
    /// Optional 32-byte master seed. If omitted, a random master is generated.
    pub master_seed: Option<[u8; 32]>,
    /// Optional human-readable label stored in the public header.
    pub label: Option<String>,
    /// Explicit access value. If omitted, a generated 32-byte access value is
    /// produced and returned.
    pub access_value: Option<String>,
    /// How the access value derives the AES key.
    pub access_mode: AccessMode,
}

impl Default for CreateOptions {
    fn default() -> Self {
        Self {
            network: Network::Testnet,
            member_count: 1,
            master_seed: None,
            label: None,
            access_value: None,
            access_mode: AccessMode::Generated,
        }
    }
}

/// Summary returned after a successful [`WalletPool::create`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateResult {
    /// The newly created pool identifier.
    pub wallet_pool_id: String,
    /// The access value that unlocks the pool.
    pub access_value: String,
    /// Network the pool is bound to.
    pub network: Network,
    /// Number of members generated (not counting the master).
    pub member_count: u32,
}

/// Options for opening an existing wallet pool.
#[derive(Clone, Debug)]
pub struct OpenOptions {
    /// Pool identifier to open.
    pub id: String,
    /// Access value that unlocks the sealed payload.
    pub access_value: String,
    /// Expected network; must match the stored pool network.
    pub network: Network,
    /// Cache behavior for decrypted keys.
    pub cache_mode: CacheMode,
}

/// Options for listing wallet entries.
#[derive(Clone, Debug, Default)]
pub struct ListOptions {
    /// Pool identifier.
    pub id: String,
    /// Filter predicate applied to the public index.
    pub filter: Filter,
    /// Optional sort order.
    pub sort: Option<Sort>,
    /// Optional pagination window.
    pub pagination: Option<Pagination>,
    /// Whether to fetch live balances and include them while filtering.
    pub live_balances: bool,
}

/// Options for viewing balances.
#[derive(Clone, Debug)]
pub struct BalanceOptions {
    /// Pool identifier.
    pub id: String,
    /// Specific address to query, or `None` to query every entry.
    pub address: Option<String>,
}

/// Options for enabling or disabling a wallet entry.
#[derive(Clone, Debug)]
pub struct SetEnabledOptions {
    /// Pool identifier.
    pub id: String,
    /// Entry to mutate.
    pub by: By,
    /// New enabled state.
    pub enabled: bool,
}

/// Options for signing and executing a transaction as a pool member.
#[derive(Clone, Debug)]
pub struct SignAndExecuteOptions {
    /// Member that will sign the transaction.
    pub by: By,
    /// Programmable transaction block to sign and execute.
    pub ptb: sui_sdk_types::ProgrammableTransaction,
    /// Whether to poll the RPC until transaction effects are available.
    pub await_effects: bool,
}

/// Options for funding recipients from the pool master.
#[derive(Clone, Debug)]
pub struct FundOptions {
    /// Coin type to transfer (defaults to `0x2::sui::SUI`).
    pub coin_type: Option<String>,
    /// Amount each recipient receives.
    pub amount_per_recipient: u64,
    /// Recipient addresses.
    pub recipients: Vec<String>,
    /// Whether to poll the RPC until transaction effects are available.
    pub await_effects: bool,
}

/// Summary of a stored pool for [`WalletPool::list_pools`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolSummary {
    /// Pool identifier.
    pub wallet_pool_id: String,
    /// Network the pool is bound to.
    pub network: Network,
    /// Optional human-readable label.
    pub label: Option<String>,
    /// Total number of entries in the public index (master + members).
    pub entry_count: usize,
    /// Number of enabled entries.
    pub enabled_count: usize,
    /// Pool creation timestamp in milliseconds since the Unix epoch.
    pub created_at: u64,
}

/// Balance map returned by [`WalletPool::view_balance`], keyed by address.
pub type WalletBalanceMap = HashMap<String, BalanceMap>;

/// Main wallet pool client.
#[derive(Clone)]
pub struct WalletPool {
    store: Arc<dyn WalletPoolStore>,
    rpc: Arc<dyn SuiRpc>,
}

impl std::fmt::Debug for WalletPool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WalletPool").finish_non_exhaustive()
    }
}

impl WalletPool {
    /// Build a new pool client backed by `store` and `rpc`.
    pub fn new(store: Arc<dyn WalletPoolStore>, rpc: Arc<dyn SuiRpc>) -> Self {
        Self { store, rpc }
    }

    /// Create a new pool, seal the member secrets, and persist the blob.
    pub async fn create(&self, opts: CreateOptions) -> Result<CreateResult> {
        let access_value = opts
            .access_value
            .clone()
            .unwrap_or_else(wallet_pool_core::envelope::generate_access_value);

        let created_at = now_millis();
        let mut result = create_blob(
            opts.network,
            opts.member_count,
            opts.master_seed,
            opts.label,
        )?;
        result.blob.created_at = created_at;

        let members = SealedMembers::with_master_secret(
            result.master_secret,
            result
                .member_secrets
                .into_iter()
                .enumerate()
                .map(|(i, secret)| MemberSecret::new((i + 1) as u32, secret))
                .collect(),
        );

        let plaintext = serde_json::to_vec(&members)
            .map_err(|e| Error::Core(wallet_pool_core::error::Error::InvalidBlob(e.to_string())))?;
        let aad = aad_for(&result.blob);
        result.blob.crypto = seal(&plaintext, &access_value, opts.access_mode, &aad)?;

        let bytes = serialize_blob(&result.blob)?;
        self.store
            .write(&result.blob.wallet_pool_id, &bytes)
            .await?;

        Ok(CreateResult {
            wallet_pool_id: result.blob.wallet_pool_id,
            access_value,
            network: opts.network,
            member_count: opts.member_count,
        })
    }

    /// Open a pool, decrypt its sealed payload, and return a handle.
    pub async fn open(&self, opts: OpenOptions) -> Result<WalletPoolHandle> {
        let bytes = self
            .store
            .read(&opts.id)
            .await?
            .ok_or_else(|| Error::Store(format!("pool not found: {}", opts.id)))?;
        let blob = parse_blob(&bytes)?;

        if blob.network != opts.network {
            return Err(Error::Core(
                wallet_pool_core::error::Error::NetworkMismatch {
                    expected: blob.network.to_string(),
                    got: opts.network.to_string(),
                },
            ));
        }

        let aad = aad_for(&blob);
        let plaintext = unseal(&blob.crypto, &opts.access_value, &aad)?;
        let members: SealedMembers = serde_json::from_slice(&plaintext)
            .map_err(|e| Error::Core(wallet_pool_core::error::Error::InvalidBlob(e.to_string())))?;

        let key_cache = KeyCache::new(256, Duration::from_secs(60));
        if opts.cache_mode == CacheMode::Default {
            pre_warm_cache(&blob, &members, &key_cache)?;
        }

        Ok(WalletPoolHandle {
            blob,
            members,
            store: self.store.clone(),
            rpc: self.rpc.clone(),
            key_cache,
        })
    }

    /// List and optionally filter/sort/paginate the public index of a pool.
    ///
    /// When `live_balances` is true, balances are fetched for each filtered
    /// entry and supplied to the filter predicate.
    pub async fn list(&self, opts: ListOptions) -> Result<Vec<WalletEntry>> {
        let blob = self.read_blob(&opts.id).await?;
        let now_ms = now_millis();

        let out: Vec<&WalletEntry> = if opts.live_balances {
            let mut balances_map: HashMap<String, BalanceMap> = HashMap::new();
            for entry in &blob.index {
                let rpc_balances = self.rpc.get_all_balances(&entry.address).await?;
                balances_map.insert(entry.address.clone(), balances_to_core_map(&rpc_balances));
            }

            let mut matched = Vec::new();
            for entry in &blob.index {
                let balances = balances_map.get(&entry.address).cloned();
                if opts.filter.matches(entry, &balances, now_ms) {
                    matched.push(entry);
                }
            }
            sort_and_paginate(matched, opts.sort, opts.pagination)
        } else {
            apply_filter(
                &blob.index,
                &opts.filter,
                &None,
                now_ms,
                opts.sort,
                opts.pagination,
            )
        };

        Ok(out.into_iter().cloned().collect())
    }

    /// Return live balances for one or all entries in a pool.
    pub async fn view_balance(&self, opts: BalanceOptions) -> Result<WalletBalanceMap> {
        let blob = self.read_blob(&opts.id).await?;
        let mut map = WalletBalanceMap::new();

        for entry in &blob.index {
            if let Some(ref address) = opts.address {
                if &entry.address != address {
                    continue;
                }
            }
            let balances = self.rpc.get_all_balances(&entry.address).await?;
            map.insert(entry.address.clone(), balances_to_core_map(&balances));
        }

        Ok(map)
    }

    /// Enable or disable a specific entry in a pool's public index.
    pub async fn set_enabled(&self, opts: SetEnabledOptions) -> Result<()> {
        let mut blob = self.read_blob(&opts.id).await?;
        let entry = find_entry_mut(&mut blob.index, &opts.by).ok_or_else(|| {
            Error::Core(wallet_pool_core::error::Error::MemberNotFound {
                by: opts.by.describe(),
            })
        })?;
        entry.enabled = opts.enabled;

        let bytes = serialize_blob(&blob)?;
        self.store.write(&opts.id, &bytes).await?;
        Ok(())
    }

    /// Return the raw stored bytes for a pool.
    pub async fn export(&self, id: &str) -> Result<Vec<u8>> {
        self.store
            .read(id)
            .await?
            .ok_or_else(|| Error::Store(format!("pool not found: {id}")))
    }

    /// Parse a blob and write it to the store under its own pool id.
    pub async fn import(&self, blob: &[u8]) -> Result<String> {
        let blob = parse_blob(blob)?;
        let bytes = serialize_blob(&blob)?;
        self.store.write(&blob.wallet_pool_id, &bytes).await?;
        Ok(blob.wallet_pool_id)
    }

    /// Delete a pool from the store.
    pub async fn delete(&self, id: &str) -> Result<()> {
        self.store.delete(id).await?;
        Ok(())
    }

    /// Return a summary for every stored pool.
    pub async fn list_pools(&self) -> Result<Vec<PoolSummary>> {
        let ids = self.store.list().await?;
        let mut summaries = Vec::with_capacity(ids.len());

        for id in ids {
            match self.read_blob(&id).await {
                Ok(blob) => summaries.push(PoolSummary {
                    wallet_pool_id: blob.wallet_pool_id,
                    network: blob.network,
                    label: blob.label,
                    entry_count: blob.index.len(),
                    enabled_count: blob.index.iter().filter(|e| e.enabled).count(),
                    created_at: blob.created_at,
                }),
                Err(_) => continue,
            }
        }

        Ok(summaries)
    }

    async fn read_blob(&self, id: &str) -> Result<PoolBlob> {
        let bytes = self
            .store
            .read(id)
            .await?
            .ok_or_else(|| Error::Store(format!("pool not found: {id}")))?;
        Ok(parse_blob(&bytes)?)
    }
}

/// A handle to an opened pool with decrypted keys held in memory.
#[derive(Clone)]
pub struct WalletPoolHandle {
    blob: PoolBlob,
    members: SealedMembers,
    store: Arc<dyn WalletPoolStore>,
    rpc: Arc<dyn SuiRpc>,
    key_cache: KeyCache<String, KeyPair>,
}

impl std::fmt::Debug for WalletPoolHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WalletPoolHandle")
            .field("wallet_pool_id", &self.blob.wallet_pool_id)
            .field("network", &self.blob.network)
            .field("entry_count", &self.blob.index.len())
            .finish_non_exhaustive()
    }
}

impl WalletPoolHandle {
    /// Return the decrypted key pair for a selected member.
    ///
    /// This method is synchronous: it only touches in-memory state.
    pub fn get_member_key(&self, by: By) -> Result<KeyPair> {
        if let Some(kp) = self.key_cache.get(&cache_key_for(&self.blob, &by)?) {
            return Ok(kp);
        }

        self.resolve_keypair(&by)
    }

    /// Sign and execute a programmable transaction block as the selected member.
    pub async fn sign_and_execute(&mut self, opts: SignAndExecuteOptions) -> Result<String> {
        let keypair = self.get_member_key(opts.by.clone())?;
        let sender = ed25519_address(&keypair.public_key());
        let sign_opts = crate::sign::SignOptions {
            ptb: opts.ptb,
            await_effects: opts.await_effects,
        };
        let digest =
            crate::sign::sign_and_execute(self.rpc.as_ref(), &keypair, &sender, sign_opts).await?;

        let entry = find_entry_mut(&mut self.blob.index, &opts.by).ok_or_else(|| {
            Error::Core(wallet_pool_core::error::Error::MemberNotFound {
                by: opts.by.describe(),
            })
        })?;
        entry.use_count += 1;
        entry.last_used_at = now_millis();

        let bytes = serialize_blob(&self.blob)?;
        self.store.write(&self.blob.wallet_pool_id, &bytes).await?;
        Ok(digest)
    }

    /// Fund recipients from the pool master in a single PTB.
    pub async fn fund(&mut self, opts: FundOptions) -> Result<String> {
        let master_keypair = self.get_member_key(By::Ordinal(0))?;
        let master_address = self
            .blob
            .index
            .iter()
            .find(|e| e.role == WalletRole::Master)
            .map(|e| e.address.clone())
            .ok_or(Error::Core(
                wallet_pool_core::error::Error::MasterNotRetrievable,
            ))?;

        let coin_type = opts.coin_type.unwrap_or_else(|| "0x2::sui::SUI".into());
        let recipients = opts.recipients.clone();
        let fund_opts = crate::fund::FundOptions {
            coin_type: coin_type.clone(),
            amount_per_recipient: opts.amount_per_recipient,
            recipients: opts.recipients,
            await_effects: opts.await_effects,
        };

        let digest = crate::fund::fund(
            self.rpc.as_ref(),
            &master_keypair,
            &master_address,
            fund_opts,
        )
        .await?;

        let now = now_millis();
        let amount_str = opts.amount_per_recipient.to_string();
        for recipient in &recipients {
            if let Some(entry) = self.blob.index.iter_mut().find(|e| &e.address == recipient) {
                entry.last_funded_at = Some(now);
                entry
                    .funded_amounts
                    .get_or_insert_with(HashMap::new)
                    .insert(coin_type.clone(), amount_str.clone());
            }
        }

        let bytes = serialize_blob(&self.blob)?;
        self.store.write(&self.blob.wallet_pool_id, &bytes).await?;
        Ok(digest)
    }

    /// Clear the key cache and overwrite decrypted secrets in memory.
    pub fn wipe(&mut self) {
        self.key_cache.clear();
        self.members.master_secret = zero_base64(&self.members.master_secret);
        for member in &mut self.members.members {
            member.secret = zero_base64(&member.secret);
        }
        self.members.members.clear();
    }

    /// Consume the handle and wipe its secrets.
    pub fn close(mut self) {
        self.wipe();
    }

    fn resolve_keypair(&self, by: &By) -> Result<KeyPair> {
        let entry = find_entry(&self.blob.index, by).ok_or_else(|| {
            Error::Core(wallet_pool_core::error::Error::MemberNotFound { by: by.describe() })
        })?;

        if !entry.enabled {
            return Err(Error::Core(
                wallet_pool_core::error::Error::AccountDisabled {
                    address: entry.address.clone(),
                },
            ));
        }

        let secret = if entry.role == WalletRole::Master {
            self.members.decoded_master_secret()?
        } else {
            let member = self
                .members
                .members
                .iter()
                .find(|m| m.ordinal == entry.ordinal)
                .ok_or_else(|| {
                    Error::Core(wallet_pool_core::error::Error::MemberNotFound {
                        by: format!("ordinal={}", entry.ordinal),
                    })
                })?;
            member.decoded_secret()?
        };

        Ok(keypair_from_secret(&secret))
    }
}

fn pre_warm_cache(
    blob: &PoolBlob,
    members: &SealedMembers,
    key_cache: &KeyCache<String, KeyPair>,
) -> Result<()> {
    if let Some(master_entry) = blob.index.iter().find(|e| e.role == WalletRole::Master) {
        let kp = keypair_from_secret(&members.decoded_master_secret()?);
        key_cache.set(master_entry.address.clone(), kp);
    }

    for member in &members.members {
        if let Some(entry) = blob.index.iter().find(|e| e.ordinal == member.ordinal) {
            let kp = keypair_from_secret(&member.decoded_secret()?);
            key_cache.set(entry.address.clone(), kp);
        }
    }

    Ok(())
}

fn find_entry<'a>(entries: &'a [WalletEntry], by: &By) -> Option<&'a WalletEntry> {
    match by {
        By::Address(addr) => entries.iter().find(|e| &e.address == addr),
        By::Ordinal(ordinal) => entries.iter().find(|e| e.ordinal == *ordinal),
    }
}

fn find_entry_mut<'a>(entries: &'a mut [WalletEntry], by: &By) -> Option<&'a mut WalletEntry> {
    match by {
        By::Address(addr) => entries.iter_mut().find(|e| &e.address == addr),
        By::Ordinal(ordinal) => entries.iter_mut().find(|e| e.ordinal == *ordinal),
    }
}

fn cache_key_for(blob: &PoolBlob, by: &By) -> Result<String> {
    match by {
        By::Address(addr) => Ok(addr.clone()),
        By::Ordinal(_) => {
            let entry = find_entry(&blob.index, by).ok_or_else(|| {
                Error::Core(wallet_pool_core::error::Error::MemberNotFound { by: by.describe() })
            })?;
            Ok(entry.address.clone())
        }
    }
}

fn balances_to_core_map(balances: &[crate::rpc::Balance]) -> BalanceMap {
    balances
        .iter()
        .map(|b| (b.coin_type.clone(), b.total_balance))
        .collect()
}

fn sort_and_paginate(
    mut entries: Vec<&WalletEntry>,
    sort: Option<Sort>,
    pagination: Option<Pagination>,
) -> Vec<&WalletEntry> {
    if let Some(sort) = sort {
        entries.sort_by(|a, b| {
            let ord = match sort.field {
                SortField::Ordinal => a.ordinal.cmp(&b.ordinal),
                SortField::Address => a.address.cmp(&b.address),
                SortField::LastUsedAt => a.last_used_at.cmp(&b.last_used_at),
            };
            if sort.descending {
                ord.reverse()
            } else {
                ord
            }
        });
    }

    if let Some(p) = pagination {
        let start = p.offset.min(entries.len());
        let end = p
            .limit
            .map(|limit| start.saturating_add(limit).min(entries.len()))
            .unwrap_or(entries.len());
        entries[start..end].to_vec()
    } else {
        entries
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is after Unix epoch")
        .as_millis() as u64
}

/// Return a base64 string of the same length as `value` but encoding zeros.
fn zero_base64(value: &str) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    STANDARD.encode(vec![0u8; value.len()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{Balance, Coin, ExecuteResponse, SuiRpc};
    use crate::store::FileWalletPoolStore;
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct MockRpc {
        balances: Arc<Mutex<HashMap<String, Vec<Balance>>>>,
        execute_response: Arc<Mutex<Option<ExecuteResponse>>>,
        wait_ok: Arc<Mutex<bool>>,
    }

    impl MockRpc {
        fn with_balance(self, address: &str, balance: Balance) -> Self {
            self.balances
                .lock()
                .unwrap()
                .entry(address.into())
                .or_default()
                .push(balance);
            self
        }

        fn with_execute_response(self, response: ExecuteResponse) -> Self {
            *self.execute_response.lock().unwrap() = Some(response);
            self
        }

        fn with_wait_ok(self, ok: bool) -> Self {
            *self.wait_ok.lock().unwrap() = ok;
            self
        }
    }

    #[async_trait]
    impl SuiRpc for MockRpc {
        async fn get_all_balances(&self, address: &str) -> Result<Vec<Balance>> {
            Ok(self
                .balances
                .lock()
                .unwrap()
                .get(address)
                .cloned()
                .unwrap_or_default())
        }

        async fn get_coins(&self, _owner: &str, _coin_type: &str) -> Result<Vec<Coin>> {
            Ok(vec![Coin {
                coin_type: "0x2::sui::SUI".into(),
                object_id: "0x1111111111111111111111111111111111111111111111111111111111111111"
                    .into(),
                version: 1,
                digest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
                balance: 1_000_000_000,
            }])
        }

        async fn execute_transaction(
            &self,
            _tx_bytes: &[u8],
            _signatures: Vec<Vec<u8>>,
        ) -> Result<ExecuteResponse> {
            self.execute_response
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| Error::Rpc("no canned execute response".into()))
        }

        async fn wait_for_transaction(&self, _digest: &str) -> Result<()> {
            if *self.wait_ok.lock().unwrap() {
                Ok(())
            } else {
                Err(Error::Rpc("canned wait failure".into()))
            }
        }

        async fn faucet_request(&self, _address: &str) -> Result<()> {
            Ok(())
        }
    }

    fn pool(store: Arc<FileWalletPoolStore>, rpc: Arc<dyn SuiRpc>) -> WalletPool {
        WalletPool::new(store, rpc)
    }

    #[tokio::test]
    async fn create_and_open_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(FileWalletPoolStore::new(dir.path()));
        let rpc: Arc<dyn SuiRpc> = Arc::new(MockRpc::default());
        let pool = pool(store, rpc);

        let create_opts = CreateOptions {
            network: Network::Testnet,
            member_count: 2,
            ..Default::default()
        };
        let created = pool.create(create_opts).await.unwrap();
        assert!(created.wallet_pool_id.starts_with("wp_"));
        assert_eq!(created.network, Network::Testnet);
        assert_eq!(created.member_count, 2);

        let handle = pool
            .open(OpenOptions {
                id: created.wallet_pool_id.clone(),
                access_value: created.access_value.clone(),
                network: Network::Testnet,
                cache_mode: CacheMode::Default,
            })
            .await
            .unwrap();

        let master_key = handle.get_member_key(By::Ordinal(0)).unwrap();
        let master_entry = &handle.blob.index[0];
        assert_eq!(
            ed25519_address(&master_key.public_key()),
            master_entry.address
        );
        assert_eq!(master_entry.role, WalletRole::Master);

        let member_key = handle.get_member_key(By::Ordinal(1)).unwrap();
        let member_entry = &handle.blob.index[1];
        assert_eq!(
            ed25519_address(&member_key.public_key()),
            member_entry.address
        );
        assert_eq!(member_entry.role, WalletRole::Member);

        // Address-based lookup works and returns the same key.
        let by_address = handle
            .get_member_key(By::Address(member_entry.address.clone()))
            .unwrap();
        assert_eq!(by_address.public_key(), member_key.public_key());
    }

    #[tokio::test]
    async fn open_rejects_wrong_network() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(FileWalletPoolStore::new(dir.path()));
        let rpc: Arc<dyn SuiRpc> = Arc::new(MockRpc::default());
        let pool = pool(store, rpc);

        let created = pool
            .create(CreateOptions {
                network: Network::Testnet,
                member_count: 1,
                ..Default::default()
            })
            .await
            .unwrap();

        let err = pool
            .open(OpenOptions {
                id: created.wallet_pool_id,
                access_value: created.access_value,
                network: Network::Mainnet,
                cache_mode: CacheMode::Default,
            })
            .await
            .unwrap_err();

        assert!(
            matches!(err, Error::Core(_)),
            "expected core error, got {err}"
        );
    }

    #[tokio::test]
    async fn list_filter_and_live_balances() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(FileWalletPoolStore::new(dir.path()));
        let member_address;
        let created;
        {
            let rpc: Arc<dyn SuiRpc> = Arc::new(MockRpc::default());
            let pool = pool(store.clone(), rpc);
            created = pool
                .create(CreateOptions {
                    network: Network::Testnet,
                    member_count: 2,
                    ..Default::default()
                })
                .await
                .unwrap();

            let handle = pool
                .open(OpenOptions {
                    id: created.wallet_pool_id.clone(),
                    access_value: created.access_value.clone(),
                    network: Network::Testnet,
                    cache_mode: CacheMode::Default,
                })
                .await
                .unwrap();
            member_address = handle.blob.index[1].address.clone();
        }

        let rpc: Arc<dyn SuiRpc> = Arc::new(MockRpc::default().with_balance(
            &member_address,
            Balance {
                coin_type: "0x2::sui::SUI".into(),
                coin_object_count: 1,
                total_balance: 5_000,
            },
        ));
        let pool = pool(store, rpc);

        let all = pool
            .list(ListOptions {
                id: created.wallet_pool_id.clone(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(all.len(), 3);

        let members_only = pool
            .list(ListOptions {
                id: created.wallet_pool_id.clone(),
                filter: Filter {
                    role: Some(WalletRole::Member),
                    ..Default::default()
                },
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(members_only.len(), 2);

        let with_balance = pool
            .list(ListOptions {
                id: created.wallet_pool_id.clone(),
                filter: Filter {
                    coin_type: Some("0x2::sui::SUI".into()),
                    balance_min: Some(1_000),
                    ..Default::default()
                },
                live_balances: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(with_balance.len(), 1);
        assert_eq!(with_balance[0].address, member_address);
    }

    #[tokio::test]
    async fn set_enabled_persists() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(FileWalletPoolStore::new(dir.path()));
        let rpc: Arc<dyn SuiRpc> = Arc::new(MockRpc::default());
        let pool = pool(store, rpc);

        let created = pool
            .create(CreateOptions {
                network: Network::Testnet,
                member_count: 1,
                ..Default::default()
            })
            .await
            .unwrap();

        pool.set_enabled(SetEnabledOptions {
            id: created.wallet_pool_id.clone(),
            by: By::Ordinal(1),
            enabled: false,
        })
        .await
        .unwrap();

        let entries = pool
            .list(ListOptions {
                id: created.wallet_pool_id,
                filter: Filter {
                    enabled: Some(false),
                    ..Default::default()
                },
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].ordinal, 1);
    }

    #[tokio::test]
    async fn export_import_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(FileWalletPoolStore::new(dir.path()));
        let rpc: Arc<dyn SuiRpc> = Arc::new(MockRpc::default());
        let pool = pool(store, rpc);

        let created = pool
            .create(CreateOptions {
                network: Network::Testnet,
                member_count: 1,
                ..Default::default()
            })
            .await
            .unwrap();

        let exported = pool.export(&created.wallet_pool_id).await.unwrap();
        assert!(exported.len() > 100);

        let imported_id = pool.import(&exported).await.unwrap();
        assert_eq!(imported_id, created.wallet_pool_id);

        let summaries = pool.list_pools().await.unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].wallet_pool_id, created.wallet_pool_id);
        assert_eq!(summaries[0].entry_count, 2);

        pool.delete(&created.wallet_pool_id).await.unwrap();
        assert!(pool.export(&created.wallet_pool_id).await.is_err());
        assert!(pool.list_pools().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn handle_fund_and_sign_delegate_to_helpers() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(FileWalletPoolStore::new(dir.path()));
        let rpc: Arc<dyn SuiRpc> = Arc::new(
            MockRpc::default()
                .with_execute_response(ExecuteResponse {
                    digest: "txdigest".into(),
                    effects: None,
                })
                .with_wait_ok(true),
        );
        let pool = pool(store, rpc);

        let created = pool
            .create(CreateOptions {
                network: Network::Testnet,
                member_count: 1,
                ..Default::default()
            })
            .await
            .unwrap();

        let mut handle = pool
            .open(OpenOptions {
                id: created.wallet_pool_id.clone(),
                access_value: created.access_value.clone(),
                network: Network::Testnet,
                cache_mode: CacheMode::Default,
            })
            .await
            .unwrap();

        let recipient = handle.blob.index[1].address.clone();
        let fund_digest = handle
            .fund(FundOptions {
                coin_type: Some("0x2::sui::SUI".into()),
                amount_per_recipient: 100_000,
                recipients: vec![recipient.clone()],
                await_effects: true,
            })
            .await
            .unwrap();
        assert_eq!(fund_digest, "txdigest");

        let sign_digest = handle
            .sign_and_execute(SignAndExecuteOptions {
                by: By::Ordinal(1),
                ptb: sui_sdk_types::ProgrammableTransaction {
                    inputs: Vec::new(),
                    commands: Vec::new(),
                },
                await_effects: true,
            })
            .await
            .unwrap();
        assert_eq!(sign_digest, "txdigest");

        // Verify metadata updates were persisted.
        let reopened = pool
            .open(OpenOptions {
                id: created.wallet_pool_id,
                access_value: created.access_value,
                network: Network::Testnet,
                cache_mode: CacheMode::None,
            })
            .await
            .unwrap();
        let member_entry = reopened
            .blob
            .index
            .iter()
            .find(|e| e.address == recipient)
            .unwrap();
        assert_eq!(member_entry.use_count, 1);
        assert!(member_entry.last_used_at > 0);
        assert!(member_entry.last_funded_at.is_some());
        assert_eq!(
            member_entry
                .funded_amounts
                .as_ref()
                .and_then(|m| m.get("0x2::sui::SUI")),
            Some(&"100000".to_string())
        );
    }

    #[tokio::test]
    async fn disabled_member_cannot_be_used() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(FileWalletPoolStore::new(dir.path()));
        let rpc: Arc<dyn SuiRpc> = Arc::new(MockRpc::default());
        let pool = pool(store, rpc);

        let created = pool
            .create(CreateOptions {
                network: Network::Testnet,
                member_count: 1,
                ..Default::default()
            })
            .await
            .unwrap();

        pool.set_enabled(SetEnabledOptions {
            id: created.wallet_pool_id.clone(),
            by: By::Ordinal(1),
            enabled: false,
        })
        .await
        .unwrap();

        let handle = pool
            .open(OpenOptions {
                id: created.wallet_pool_id,
                access_value: created.access_value,
                network: Network::Testnet,
                cache_mode: CacheMode::None,
            })
            .await
            .unwrap();

        let err = handle.get_member_key(By::Ordinal(1)).unwrap_err();
        assert!(
            matches!(err, Error::Core(_)),
            "expected core error, got {err}"
        );
    }

    #[tokio::test]
    async fn view_balance_returns_balances_by_address() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(FileWalletPoolStore::new(dir.path()));
        let created;
        let member_address;
        {
            let rpc: Arc<dyn SuiRpc> = Arc::new(MockRpc::default());
            let pool = pool(store.clone(), rpc);
            created = pool
                .create(CreateOptions {
                    network: Network::Testnet,
                    member_count: 1,
                    ..Default::default()
                })
                .await
                .unwrap();
            let handle = pool
                .open(OpenOptions {
                    id: created.wallet_pool_id.clone(),
                    access_value: created.access_value.clone(),
                    network: Network::Testnet,
                    cache_mode: CacheMode::Default,
                })
                .await
                .unwrap();
            member_address = handle.blob.index[1].address.clone();
        }

        let rpc: Arc<dyn SuiRpc> = Arc::new(MockRpc::default().with_balance(
            &member_address,
            Balance {
                coin_type: "0x2::sui::SUI".into(),
                coin_object_count: 1,
                total_balance: 9_000,
            },
        ));
        let pool = pool(store, rpc);

        let balances = pool
            .view_balance(BalanceOptions {
                id: created.wallet_pool_id,
                address: Some(member_address.clone()),
            })
            .await
            .unwrap();
        assert_eq!(balances.len(), 1);
        let member_balances = balances.get(&member_address).unwrap();
        assert_eq!(member_balances.get("0x2::sui::SUI").copied(), Some(9_000));
    }

    #[tokio::test]
    async fn full_lifecycle_from_create_to_delete() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(FileWalletPoolStore::new(dir.path()));
        let rpc: Arc<dyn SuiRpc> = Arc::new(MockRpc::default());
        let pool = pool(store, rpc);

        // Create a pool with two members.
        let created = pool
            .create(CreateOptions {
                network: Network::Testnet,
                member_count: 2,
                ..Default::default()
            })
            .await
            .unwrap();

        // Open the pool and verify member keys can be resolved.
        let handle = pool
            .open(OpenOptions {
                id: created.wallet_pool_id.clone(),
                access_value: created.access_value.clone(),
                network: Network::Testnet,
                cache_mode: CacheMode::Default,
            })
            .await
            .unwrap();
        let member_address = handle.blob.index[1].address.clone();
        let by_address_key = handle
            .get_member_key(By::Address(member_address.clone()))
            .unwrap();
        assert_eq!(
            ed25519_address(&by_address_key.public_key()),
            member_address
        );

        // List all entries and filter down to members only.
        let all = pool
            .list(ListOptions {
                id: created.wallet_pool_id.clone(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(all.len(), 3);

        let members_only = pool
            .list(ListOptions {
                id: created.wallet_pool_id.clone(),
                filter: Filter {
                    role: Some(WalletRole::Member),
                    ..Default::default()
                },
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(members_only.len(), 2);

        // Disable one member and confirm the mutation persists.
        pool.set_enabled(SetEnabledOptions {
            id: created.wallet_pool_id.clone(),
            by: By::Address(member_address.clone()),
            enabled: false,
        })
        .await
        .unwrap();

        let disabled = pool
            .list(ListOptions {
                id: created.wallet_pool_id.clone(),
                filter: Filter {
                    enabled: Some(false),
                    ..Default::default()
                },
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(disabled.len(), 1);
        assert_eq!(disabled[0].address, member_address);

        // Export, delete, import, and verify the store reflects the imported pool.
        let exported = pool.export(&created.wallet_pool_id).await.unwrap();
        assert!(!exported.is_empty());

        pool.delete(&created.wallet_pool_id).await.unwrap();
        assert!(pool.export(&created.wallet_pool_id).await.is_err());
        assert!(pool.list_pools().await.unwrap().is_empty());

        let imported_id = pool.import(&exported).await.unwrap();
        assert_eq!(imported_id, created.wallet_pool_id);

        let summaries = pool.list_pools().await.unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].wallet_pool_id, created.wallet_pool_id);

        // Clean up.
        pool.delete(&created.wallet_pool_id).await.unwrap();
    }

    #[tokio::test]
    async fn open_with_wrong_access_value_returns_core_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(FileWalletPoolStore::new(dir.path()));
        let rpc: Arc<dyn SuiRpc> = Arc::new(MockRpc::default());
        let pool = pool(store, rpc);

        let created = pool
            .create(CreateOptions {
                network: Network::Testnet,
                member_count: 1,
                ..Default::default()
            })
            .await
            .unwrap();

        let wrong_access = wallet_pool_core::envelope::generate_access_value();
        let err = pool
            .open(OpenOptions {
                id: created.wallet_pool_id,
                access_value: wrong_access,
                network: Network::Testnet,
                cache_mode: CacheMode::Default,
            })
            .await
            .unwrap_err();

        assert!(
            matches!(
                err,
                Error::Core(wallet_pool_core::error::Error::WrongAccessValue)
            ),
            "expected WrongAccessValue core error, got {err}"
        );
    }
}
