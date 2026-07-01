//! Funded seat-B identity source for on-demand arena bots (PR #124 wallet pool).
//!
//! Opened once at startup (`build` from `WALLET_POOL_ID` + S3 creds); each on-demand bot draws a real
//! on-chain seat-B address via [`WalletPoolSource::checkout_address`], replacing the deterministic
//! placeholder. Selection is round-robin over the 1M members — at 1M >> peak concurrency no two
//! concurrent matches share a wallet, so an explicit return-on-settle free-list is deferred (a
//! hardening for the funded path; today the opener is `Noop` and the pool is unfunded, so this wires
//! identity only).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use anyhow::Context;
use wallet_pool::rpc::ReqwestRpc;
use wallet_pool::{By, CacheMode, Network, OpenOptions, WalletPool, WalletPoolHandle};
use wallet_pool_s3::S3WalletPoolStore;

/// A wallet-pool handle plus a round-robin cursor over the FUNDED members.
///
/// The 1M-member pool is only partially funded (empirically a contiguous prefix `1..=funded_count`,
/// each holding ≫ stake MTPS); the rest are empty and would revert `deposit_party_b`. Live-balance
/// filtering is O(pool) RPC (`list(live_balances)` re-streams the 332 MiB blob), so the funded count
/// is **configured** (`WALLET_POOL_FUNDED_COUNT`), not discovered, and round-robin stays inside it.
pub struct WalletPoolSource {
    handle: WalletPoolHandle,
    funded_count: u32,
    cursor: AtomicU32,
}

impl WalletPoolSource {
    /// The next funded member's on-chain seat-B address (round-robin over `1..=funded_count`).
    /// `get_member_key` is a synchronous in-memory decrypt (`CacheMode::None` + moka cache), so this
    /// is safe at allocate cadence.
    pub fn checkout_address(&self) -> anyhow::Result<String> {
        let ord = next_ordinal(&self.cursor, self.funded_count)
            .context("wallet pool has no funded members")?;
        Ok(wallet_pool_core::crypto::ed25519_address(
            &self.keypair_for_ordinal(ord)?.public_key(),
        ))
    }

    /// The keypair for a member by on-chain address — the seat-B signer the opener uses to self-sign
    /// `create + deposit_party_b`. In-memory (no S3 write); `By::Address` is a linear scan over the
    /// blob (O(members)), fine at allocate cadence where the open RPC dominates.
    pub fn keypair_for_address(
        &self,
        address: &str,
    ) -> anyhow::Result<wallet_pool_core::crypto::KeyPair> {
        self.handle
            .get_member_key(By::Address(address.to_owned()))
            .map_err(|e| anyhow::anyhow!("wallet pool key for {address}: {e}"))
    }

    fn keypair_for_ordinal(&self, ord: u32) -> anyhow::Result<wallet_pool_core::crypto::KeyPair> {
        self.handle
            .get_member_key(By::Ordinal(ord))
            .map_err(|e| anyhow::anyhow!("wallet pool get_member_key({ord}): {e}"))
    }
}

/// Round-robin member ordinal in `1..=member_count` (member 0 is the master, never handed out).
/// `None` when the pool is empty. Pure so the 1-based wrap is unit-testable without a real pool.
fn next_ordinal(cursor: &AtomicU32, member_count: u32) -> Option<u32> {
    if member_count == 0 {
        return None;
    }
    Some(1 + cursor.fetch_add(1, Ordering::Relaxed) % member_count)
}

/// Open the wallet pool if `WALLET_POOL_ID` is configured; otherwise `None` (bots use the placeholder
/// identity, the default dev/Noop path). The access value comes from config; the S3 bucket + AWS creds
/// from the environment ([`S3WalletPoolStore::from_env`]). The open downloads + parses the pool blob
/// once; `CacheMode::None` keeps member keys decrypt-on-demand — a 1M-member pool must not pre-warm
/// hundreds of MiB of keys.
pub async fn build(
    pool_id: Option<&str>,
    access_value: Option<&str>,
    funded_count: Option<u32>,
    rpc_url: &str,
    network: Network,
) -> anyhow::Result<Option<WalletPoolSource>> {
    let Some(pool_id) = pool_id else {
        return Ok(None);
    };
    let access_value =
        access_value.context("WALLET_POOL_ID set but WALLET_POOL_ACCESS_VALUE missing")?;
    let store = Arc::new(S3WalletPoolStore::from_env().await?);
    let rpc = Arc::new(ReqwestRpc::new(rpc_url.to_owned()));
    let handle = WalletPool::new(store, rpc)
        .open(OpenOptions {
            id: pool_id.to_owned(),
            access_value: access_value.to_owned(),
            network,
            cache_mode: CacheMode::None,
        })
        .await?;
    let members = handle.member_count();
    // Only the funded prefix is usable; default to the whole pool but warn (most members are empty).
    let funded_count = match funded_count {
        Some(n) => n.min(members),
        None => {
            tracing::warn!(
                members,
                "WALLET_POOL_FUNDED_COUNT unset — round-robin will span the whole pool; \
                 unfunded members revert deposit_party_b"
            );
            members
        }
    };
    tracing::info!(
        members,
        funded_count,
        "wallet pool opened for arena seat-B identities"
    );
    Ok(Some(WalletPoolSource {
        handle,
        funded_count,
        cursor: AtomicU32::new(0),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Round-robin hands out members 1..=N then wraps — never 0 (the master) — so two concurrent bots
    // (below N) never collide on a seat-B address. The 1-based wrap is the off-by-one that would
    // silently hand out the master wallet or skip a member.
    #[test]
    fn next_ordinal_cycles_one_based_and_wraps() {
        let cursor = AtomicU32::new(0);
        let seq: Vec<u32> = (0..7).filter_map(|_| next_ordinal(&cursor, 3)).collect();
        assert_eq!(seq, vec![1, 2, 3, 1, 2, 3, 1], "1..=3 round-robin, never 0");
    }

    #[test]
    fn next_ordinal_is_none_for_an_empty_pool() {
        assert_eq!(next_ordinal(&AtomicU32::new(0), 0), None);
    }
}
