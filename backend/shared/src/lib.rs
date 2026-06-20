//! Canonical types shared by the explorer indexer (writer) and explorer-api (reader).
//! `SettlementRow` is the durable read-model record; `SettlementStore` is the read-only
//! storage seam (Postgres in prod, in-memory for dev/tests). The framework (Diesel, in
//! the `explorer` crate) owns the `settlement` table, all writes, and checkpoint watermarks.

pub mod memory;
pub mod postgres;

/// A lifecycle event we index. Opens give context; settles are the verifiable closes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleKind {
    Opened,
    Settled,
}

/// One durable, queryable settlement-index row, keyed by `tx_digest`. u64 on-chain
/// values are stored as i64 (Postgres BIGINT) — SUI amounts and nonces are well within
/// i63 range. JSON is camelCase to match the SDK/frontend (ADR-0002).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettlementRow {
    pub tx_digest: String,
    pub kind: LifecycleKind,
    pub tunnel_id: String,
    pub party_a_addr: Option<String>,
    pub party_b_addr: Option<String>,
    pub party_a_balance: Option<i64>,
    pub party_b_balance: Option<i64>,
    pub final_nonce: Option<i64>,
    pub transcript_root: Option<String>,
    pub proof_url: Option<String>,
    pub walrus_blob_id: Option<String>,
    /// Sui checkpoint sequence number this lifecycle tx landed in.
    pub checkpoint: i64,
    pub timestamp_ms: i64,
    pub closed_at_ms: Option<i64>,
    pub game: Option<String>,
}

/// Keyset list query. `cursor` is an opaque `"{timestamp_ms}:{tx_digest}"` token taken from
/// a prior page's `next_cursor` (exclusive), newest-first; `None` starts at the newest. The
/// cursor is COMPOSITE (ts + digest) to match the `(timestamp_ms DESC, tx_digest DESC)` order
/// — a ts-only cursor silently drops rows that share a millisecond at a page boundary.
#[derive(Debug, Clone, Default)]
pub struct SettlementQuery {
    pub cursor: Option<String>,
    pub limit: i64,
    pub tunnel_id: Option<String>,
    pub address: Option<String>,
    pub kind: Option<LifecycleKind>,
}

/// Decode a `"{ts}:{digest}"` cursor token. Sui digests are base58 (never contain `:`), so
/// split on the first `:` only.
pub fn decode_cursor(token: &str) -> Option<(i64, String)> {
    let (ts, digest) = token.split_once(':')?;
    Some((ts.parse().ok()?, digest.to_string()))
}
/// Build a `"{ts}:{digest}"` keyset cursor token from a timestamp and transaction digest.
pub fn encode_cursor(ts: i64, digest: &str) -> String {
    format!("{ts}:{digest}")
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettlementPage {
    pub rows: Vec<SettlementRow>,
    /// Opaque `"{ts}:{digest}"` token to pass as the next `cursor`, or `None` on the last page.
    pub next_cursor: Option<String>,
}

/// Read-only settlement store. Single writer (framework indexer via Diesel), many readers
/// (explorer-api). `upsert`/`last_checkpoint` are NOT on this trait — the framework owns writes.
#[async_trait::async_trait]
pub trait SettlementStore: Send + Sync {
    async fn get(&self, tx_digest: &str) -> anyhow::Result<Option<SettlementRow>>;
    async fn list(&self, q: &SettlementQuery) -> anyhow::Result<SettlementPage>;
    /// Maintained counter (write-time, by the indexer's Diesel trigger), not a runtime aggregate.
    async fn settled_count(&self) -> anyhow::Result<i64>;
}
