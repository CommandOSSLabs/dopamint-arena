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
use sui_indexer_alt_framework::pipeline::Processor;
use sui_indexer_alt_framework::postgres::handler::Handler;
use sui_indexer_alt_framework::postgres::Connection;
use sui_indexer_alt_framework::types::full_checkpoint_content::Checkpoint;
use sui_indexer_alt_framework::FieldCount;

use crate::events::{event_to_row, RowData};
use crate::schema::settlement;

/// One settlement row to insert. Mirrors the on-chain-derived subset of `events::RowData`.
///
/// `proof_url`, `walrus_blob_id`, and `game` are intentionally OMITTED: the BCS lifecycle
/// events don't carry them, so they default NULL on insert and are filled downstream (proof
/// fields via the /settle enrichment path). The upsert below COALESCE-preserves them so a
/// reprocessed checkpoint never clobbers that enrichment.
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
}

/// Indexes `<package_id>::tunnel::*` lifecycle events into the `settlement` read-model.
pub struct SettlementPipeline {
    pub package_id: String,
}

#[async_trait]
impl Processor for SettlementPipeline {
    const NAME: &'static str = "settlement";
    type Value = StoredSettlement;

    async fn process(&self, checkpoint: &Arc<Checkpoint>) -> anyhow::Result<Vec<Self::Value>> {
        let seq = checkpoint.summary.sequence_number as i64;
        // StructTag Display renders the address via `short_str_lossless()` (leading zeros
        // stripped), so `TUNNEL_PACKAGE_ID` must be supplied in that same short/0x form for
        // this filter to match. Verified at e2e time against a live node, not the build gate.
        let prefix = format!("{}::tunnel::", self.package_id);

        let mut rows = Vec::new();
        for tx in &checkpoint.transactions {
            let digest = tx.transaction.digest().to_string();
            for ev in tx.events.iter().flat_map(|evs| evs.data.iter()) {
                if !ev.type_.to_string().starts_with(&prefix) {
                    continue;
                }
                // Struct name suffix from the structured field — no `::` string-split edge.
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
    async fn commit<'a>(values: &[Self::Value], conn: &mut Connection<'a>) -> anyhow::Result<usize> {
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

        // 2. Address enrichment. A settled row (close tx) carries balances but NO party
        // addresses; the addresses live on the opened row (TunnelCreated) — a DIFFERENT
        // tx_digest at an earlier checkpoint, same tunnel_id. `process()` is pure (per
        // checkpoint) so it can't join across them. We do the join here as a scoped UPDATE
        // after the insert: by the time a close commits, its open row is already present
        // because the framework commits checkpoints in order. Restricted to this batch's
        // tunnels and to still-NULL settled rows so it's idempotent and bounded.
        let settled_tunnels: Vec<String> = values
            .iter()
            .filter(|v| v.kind == "settled")
            .map(|v| v.tunnel_id.clone())
            .collect();
        if !settled_tunnels.is_empty() {
            diesel::sql_query(
                "UPDATE settlement s SET party_a_addr = o.party_a_addr, party_b_addr = o.party_b_addr \
                 FROM settlement o \
                 WHERE o.tunnel_id = s.tunnel_id AND o.kind = 'opened' \
                   AND s.kind = 'settled' AND s.party_a_addr IS NULL AND s.tunnel_id = ANY($1)",
            )
            .bind::<Array<Text>, _>(settled_tunnels)
            .execute(conn)
            .await?;
        }

        Ok(inserted)
    }
}
