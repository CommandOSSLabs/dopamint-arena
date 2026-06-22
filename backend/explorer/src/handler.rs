//! The settlement pipeline: a `Processor` that decodes tunnel lifecycle events out of each
//! checkpoint into Diesel-insertable rows, and a Postgres `Handler` that upserts them and
//! back-fills party addresses onto settled rows.
//!
//! The decode itself lives in `events.rs` (pure, unit-tested). This module owns the framework
//! wiring + the two pieces that can only happen at commit time: idempotent upsert and the
//! cross-row address enrichment join.
use std::sync::Arc;

use async_trait::async_trait;
use diesel::prelude::*;
use diesel::sql_types::{Array, Nullable, Text};
use diesel_async::RunQueryDsl;
use fred::prelude::*;
use sui_indexer_alt_framework::pipeline::Processor;
use sui_indexer_alt_framework::postgres::handler::Handler;
use sui_indexer_alt_framework::postgres::Connection;
use sui_indexer_alt_framework::types::full_checkpoint_content::Checkpoint;
use sui_indexer_alt_framework::FieldCount;

use move_core_types::account_address::AccountAddress;

use crate::events::{event_to_row, RowData};
use crate::schema::settlement;

/// Process-global Redis publisher for the live settlement feed.
///
/// WHY a global: the framework `Handler::commit` is a STATIC method (no `&self`, so no
/// per-instance Redis handle can be threaded through). The binary sets this once at startup
/// via `init_events_publisher`; `commit` reads it best-effort. Absent (no Redis) => no-op.
///
/// `RedisClient` (fred 9.x) — fred 10.x renamed this to `Client`, but we're pinned to 9.4.0.
static SETTLEMENT_EVENTS: std::sync::OnceLock<RedisClient> = std::sync::OnceLock::new();

/// Install the live-feed publisher. Idempotent: a second call is ignored (the `OnceLock` keeps
/// the first). Call once from the indexer binary after `RedisClient::init()`.
pub fn init_events_publisher(client: RedisClient) {
    let _ = SETTLEMENT_EVENTS.set(client);
}

/// Drain `pending_proof` for the given digests onto their settlement rows. Run by BOTH the
/// indexer commit (after it writes settled rows) and the `explorer:proofs` subscriber (after it
/// records a proof). Each side writes its own contribution durably first, then runs this same
/// idempotent merge — so whichever becomes durable last completes the enrichment regardless of
/// arrival order. COALESCE-preserves any already-present value, and DELETEs only the pending rows
/// it actually merged (a proof whose settlement row doesn't exist yet is kept for a later drain).
/// Bind `$1` = the digest list (`Array<Text>`). One atomic data-modifying CTE.
pub const PENDING_PROOF_DRAIN_SQL: &str = "\
WITH merged AS ( \
    UPDATE settlement s \
       SET proof_url      = COALESCE(s.proof_url, p.proof_url), \
           walrus_blob_id = COALESCE(s.walrus_blob_id, p.walrus_blob_id) \
      FROM pending_proof p \
     WHERE p.tx_digest = s.tx_digest AND s.tx_digest = ANY($1) \
    RETURNING s.tx_digest \
) \
DELETE FROM pending_proof WHERE tx_digest IN (SELECT tx_digest FROM merged)";

/// Record a proof durably so it survives arriving before the settlement row exists. COALESCE so a
/// later partial message never nulls a field already stored. Bind $1=digest, $2=proof_url,
/// $3=walrus_blob_id. Paired with `PENDING_PROOF_DRAIN_SQL` (the subscriber upserts here, then drains).
pub const PENDING_PROOF_UPSERT_SQL: &str = "\
INSERT INTO pending_proof (tx_digest, proof_url, walrus_blob_id) VALUES ($1, $2, $3) \
ON CONFLICT (tx_digest) DO UPDATE \
   SET proof_url      = COALESCE(EXCLUDED.proof_url, pending_proof.proof_url), \
       walrus_blob_id = COALESCE(EXCLUDED.walrus_blob_id, pending_proof.walrus_blob_id)";

/// One settlement row to insert. Mirrors the on-chain-derived subset of `events::RowData`.
///
/// `proof_url`, `walrus_blob_id`, and `game` are omitted from this struct (Diesel inserts NULL).
/// `proof_url`/`walrus_blob_id` are COALESCE-preserved on upsert (enriched via /settle);
/// `game` is populated by later enrichment.
#[derive(Insertable, FieldCount, Clone)]
#[diesel(table_name = crate::schema::settlement)]
pub struct StoredSettlement {
    pub tx_digest: String,
    pub kind: String,
    pub tunnel_id: String,
    pub party_a_addr: Option<String>,
    pub party_b_addr: Option<String>,
    pub party_a_balance: Option<i64>,
    pub party_b_balance: Option<i64>,
    pub final_nonce: Option<i64>,
    pub transcript_root: Option<String>,
    pub checkpoint: i64,
    pub timestamp_ms: i64,
    pub closed_at_ms: Option<i64>,
}

impl StoredSettlement {
    fn from_row(r: RowData) -> StoredSettlement {
        StoredSettlement {
            tx_digest: r.tx_digest,
            kind: r.kind.to_string(),
            tunnel_id: r.tunnel_id,
            party_a_addr: r.party_a_addr,
            party_b_addr: r.party_b_addr,
            party_a_balance: r.party_a_balance,
            party_b_balance: r.party_b_balance,
            final_nonce: r.final_nonce,
            transcript_root: r.transcript_root,
            checkpoint: r.checkpoint,
            timestamp_ms: r.timestamp_ms,
            closed_at_ms: r.closed_at_ms,
        }
    }

    /// Project this freshly-committed row to the api's camelCase wire shape for the live feed.
    /// `proof_url`/`walrus_blob_id`/`game` are intentionally `None`: at commit time the chain row
    /// carries no Walrus proof (that arrives later via the `explorer:proofs` subscriber) and no
    /// game tag. The frontend live feed only needs the settlement identity + balances.
    fn to_feed_row(&self) -> shared::SettlementRow {
        let kind = shared::LifecycleKind::from_db_str(&self.kind)
            .unwrap_or(shared::LifecycleKind::Settled);
        shared::SettlementRow {
            tx_digest: self.tx_digest.clone(),
            kind,
            tunnel_id: self.tunnel_id.clone(),
            party_a_addr: self.party_a_addr.clone(),
            party_b_addr: self.party_b_addr.clone(),
            party_a_balance: self.party_a_balance,
            party_b_balance: self.party_b_balance,
            final_nonce: self.final_nonce,
            transcript_root: self.transcript_root.clone(),
            proof_url: None,
            walrus_blob_id: None,
            checkpoint: self.checkpoint,
            timestamp_ms: self.timestamp_ms,
            closed_at_ms: self.closed_at_ms,
            game: None,
        }
    }
}

/// Indexes `<package>::tunnel::*` lifecycle events into the `settlement` read-model.
pub struct SettlementPipeline {
    pub package: AccountAddress,
}

#[async_trait]
impl Processor for SettlementPipeline {
    const NAME: &'static str = "settlement";
    type Value = StoredSettlement;

    async fn process(&self, checkpoint: &Arc<Checkpoint>) -> anyhow::Result<Vec<Self::Value>> {
        let seq = checkpoint.summary.sequence_number as i64;

        let mut rows = Vec::new();
        for tx in &checkpoint.transactions {
            let digest = tx.transaction.digest().to_string();
            for ev in tx.events.iter().flat_map(|evs| evs.data.iter()) {
                if ev.type_.address != self.package || ev.type_.module.as_str() != "tunnel" {
                    continue;
                }
                let suffix = ev.type_.name.as_str();
                if let Some(row) = event_to_row(suffix, &ev.contents, &digest, seq) {
                    rows.push(StoredSettlement::from_row(row));
                }
            }
        }
        Ok(rows)
    }
}

#[async_trait]
impl Handler for SettlementPipeline {
    async fn commit<'a>(
        values: &[Self::Value],
        conn: &mut Connection<'a>,
    ) -> anyhow::Result<usize> {
        // 1. Idempotent batch upsert. On a reprocessed checkpoint the enrichable columns
        // (addresses + proof fields) are COALESCE-preserved so re-decoding never clobbers
        // values filled in by a later open-row commit or the /settle path. Balances/nonce/
        // root are deterministic from BCS, so unmentioned columns safely retain their value.
        let inserted = diesel::insert_into(settlement::table)
            .values(values)
            .on_conflict(settlement::tx_digest)
            .do_update()
            .set((
                settlement::party_a_addr.eq(diesel::dsl::sql::<Nullable<Text>>(
                    "COALESCE(settlement.party_a_addr, EXCLUDED.party_a_addr)",
                )),
                settlement::party_b_addr.eq(diesel::dsl::sql::<Nullable<Text>>(
                    "COALESCE(settlement.party_b_addr, EXCLUDED.party_b_addr)",
                )),
                settlement::proof_url.eq(diesel::dsl::sql::<Nullable<Text>>(
                    "COALESCE(settlement.proof_url, EXCLUDED.proof_url)",
                )),
                settlement::walrus_blob_id.eq(diesel::dsl::sql::<Nullable<Text>>(
                    "COALESCE(settlement.walrus_blob_id, EXCLUDED.walrus_blob_id)",
                )),
            ))
            .execute(conn)
            .await?;

        // 2. Address enrichment (order-independent). A settled row (close tx) carries balances but
        // NO party addresses; those live on the opened row (TunnelCreated) — a different tx_digest
        // at an earlier checkpoint, same tunnel_id. `process()` is pure per checkpoint so it can't
        // join across them; we join here after the insert. The concurrent pipeline commits batches
        // OUT of order (only watermarks advance in order), so for EVERY tunnel touched in this
        // batch — opened OR settled — we (re)run the settled<-opened join. That back-fills a settled
        // row whose open committed later just as it fills one whose open committed earlier, making
        // enrichment independent of commit order. Scoped to this batch's tunnels and still-NULL
        // settled rows: idempotent and bounded.
        let mut enrich_tunnels: Vec<String> = values
            .iter()
            .filter(|v| v.kind == "settled" || v.kind == "opened")
            .map(|v| v.tunnel_id.clone())
            .collect();
        enrich_tunnels.sort();
        enrich_tunnels.dedup();
        if !enrich_tunnels.is_empty() {
            diesel::sql_query(
                "UPDATE settlement s SET party_a_addr = o.party_a_addr, party_b_addr = o.party_b_addr \
                 FROM settlement o \
                 WHERE o.tunnel_id = s.tunnel_id AND o.kind = 'opened' \
                   AND s.kind = 'settled' AND s.party_a_addr IS NULL AND s.party_b_addr IS NULL AND s.tunnel_id = ANY($1)",
            )
            .bind::<Array<Text>, _>(enrich_tunnels)
            .execute(conn)
            .await?;
        }

        // 3. Drain Walrus proof links that arrived (via `explorer:proofs`) before this row existed.
        // The subscriber records the proof into `pending_proof` and runs the same drain, so the
        // link attaches regardless of which side commits first (see `PENDING_PROOF_DRAIN_SQL`).
        let settled_digests: Vec<String> = values
            .iter()
            .filter(|v| v.kind == "settled")
            .map(|v| v.tx_digest.clone())
            .collect();
        if !settled_digests.is_empty() {
            diesel::sql_query(PENDING_PROOF_DRAIN_SQL)
                .bind::<Array<Text>, _>(settled_digests)
                .execute(conn)
                .await?;
        }

        // 4. Live feed (best-effort). Publish each SETTLED row in this batch to `explorer:events`
        // (the api fans this out as SSE). Settled-only: the frontend live feed shows settlements,
        // and a momentarily-NULL-address row is fine (the list doesn't render addresses). A
        // publish failure (no Redis, dropped connection) MUST NOT affect the commit result — this
        // is purely additive telemetry, so all errors are swallowed.
        if let Some(client) = SETTLEMENT_EVENTS.get() {
            for v in values.iter().filter(|v| v.kind == "settled") {
                if let Ok(json) = serde_json::to_string(&v.to_feed_row()) {
                    let _: Result<(), _> = client.publish("explorer:events", json).await;
                }
            }
        }

        Ok(inserted)
    }
}
