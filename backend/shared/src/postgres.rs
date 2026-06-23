//! Postgres (Aurora) read-model for the explorer-api. The `settlement` table and all writes
//! are owned by the `explorer` crate (Diesel). This reader opens the pool and queries only.
//! Integration tests are `#[ignore]` and require `TEST_DATABASE_URL`.

use sqlx::postgres::{PgPoolOptions, PgRow};
use sqlx::{PgPool, Row};

use crate::{LifecycleKind, SettlementPage, SettlementQuery, SettlementRow, SettlementStore};

pub struct PgSettlementStore {
    pool: PgPool,
}

impl PgSettlementStore {
    /// Connect and return the read store. Does NOT run migrations — Diesel (explorer crate)
    /// owns the schema. `database_url` is the RDS Proxy URL.
    pub async fn connect(database_url: &str) -> anyhow::Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }
}

fn row_from_pg(r: &PgRow) -> anyhow::Result<SettlementRow> {
    let kind_raw = r.get::<String, _>("kind");
    let kind = LifecycleKind::from_db_str(&kind_raw)
        .ok_or_else(|| anyhow::anyhow!("unrecognised lifecycle kind: {kind_raw:?}"))?;
    Ok(SettlementRow {
        tx_digest: r.get("tx_digest"),
        kind,
        tunnel_id: r.get("tunnel_id"),
        party_a_addr: r.get("party_a_addr"),
        party_b_addr: r.get("party_b_addr"),
        party_a_balance: r.get("party_a_balance"),
        party_b_balance: r.get("party_b_balance"),
        final_nonce: r.get("final_nonce"),
        transcript_root: r.get("transcript_root"),
        proof_url: r.get("proof_url"),
        walrus_blob_id: r.get("walrus_blob_id"),
        checkpoint: r.get("checkpoint"),
        timestamp_ms: r.get("timestamp_ms"),
        closed_at_ms: r.get("closed_at_ms"),
        game: r.get("game"),
    })
}

#[async_trait::async_trait]
impl SettlementStore for PgSettlementStore {
    async fn get(&self, tx_digest: &str) -> anyhow::Result<Option<SettlementRow>> {
        let r = sqlx::query("SELECT * FROM settlement WHERE tx_digest = $1")
            .bind(tx_digest)
            .fetch_optional(&self.pool)
            .await?;
        Ok(r.as_ref().map(row_from_pg).transpose()?)
    }

    async fn list(&self, q: &SettlementQuery) -> anyhow::Result<SettlementPage> {
        let limit = q.limit.clamp(1, 1000);
        // Composite keyset cursor: the row-value comparison `(ts, digest) < ($1, $2)` matches
        // the `(ts DESC, digest DESC)` order, so rows sharing a millisecond are never skipped
        // at a page edge. Both halves are NULL on page 1 (the `IS NULL` branch lets all rows in).
        let cur = q.cursor.as_deref().and_then(crate::decode_cursor);
        let cur_ts = cur.as_ref().map(|c| c.0);
        let cur_digest = cur.as_ref().map(|c| c.1.clone());
        // Fetch limit+1 to compute next_cursor without a second query.
        let rows = sqlx::query(
            r#"
            SELECT * FROM settlement
            WHERE ($1::bigint IS NULL OR (timestamp_ms, tx_digest) < ($1, $2))
              AND ($3::text IS NULL OR tunnel_id = $3)
              AND ($4::text IS NULL OR kind = $4)
              AND ($5::text IS NULL OR party_a_addr = $5 OR party_b_addr = $5)
            ORDER BY timestamp_ms DESC, tx_digest DESC
            LIMIT $6
            "#,
        )
        .bind(cur_ts)
        .bind(cur_digest)
        .bind(&q.tunnel_id)
        .bind(q.kind.map(LifecycleKind::as_str))
        .bind(&q.address)
        .bind(limit + 1)
        .fetch_all(&self.pool)
        .await?;

        let mut out: Vec<SettlementRow> = rows
            .iter()
            .map(row_from_pg)
            .collect::<anyhow::Result<Vec<_>>>()?;
        let next_cursor = if out.len() as i64 > limit {
            out.truncate(limit as usize);
            out.last()
                .map(|r| crate::encode_cursor(r.timestamp_ms, &r.tx_digest))
        } else {
            None
        };
        Ok(SettlementPage {
            rows: out,
            next_cursor,
        })
    }

    async fn settled_count(&self) -> anyhow::Result<i64> {
        Ok(
            sqlx::query_scalar("SELECT value FROM settlement_meta WHERE key = 'settled_count'")
                .fetch_one(&self.pool)
                .await?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SettlementQuery;

    // Set up a schema-owning connection for integration tests. Since `shared` is the reader
    // and Diesel (explorer crate) owns migrations, we create the tables here inline so the
    // reader has something to query. Not tested: write semantics (those belong to explorer).
    async fn store() -> Option<PgSettlementStore> {
        let url = std::env::var("TEST_DATABASE_URL").ok()?;
        let s = PgSettlementStore::connect(&url).await.expect("connect");
        // Mirror the DDL from the explorer crate's Diesel migration so the reader can be tested
        // without running the full explorer binary.
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS settlement (
                tx_digest        TEXT PRIMARY KEY,
                kind             TEXT NOT NULL,
                tunnel_id        TEXT NOT NULL,
                party_a_addr     TEXT,
                party_b_addr     TEXT,
                party_a_balance  BIGINT,
                party_b_balance  BIGINT,
                final_nonce      BIGINT,
                transcript_root  TEXT,
                proof_url        TEXT,
                walrus_blob_id   TEXT,
                checkpoint       BIGINT NOT NULL,
                timestamp_ms     BIGINT NOT NULL,
                closed_at_ms     BIGINT,
                game             TEXT
            )
            "#,
        )
        .execute(&s.pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS settlement_ts_idx ON settlement (timestamp_ms DESC, tx_digest DESC)",
        )
        .execute(&s.pool)
        .await
        .unwrap();
        sqlx::query("CREATE INDEX IF NOT EXISTS settlement_tunnel_idx ON settlement (tunnel_id)")
            .execute(&s.pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS settlement_party_a_idx ON settlement (party_a_addr)",
        )
        .execute(&s.pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS settlement_party_b_idx ON settlement (party_b_addr)",
        )
        .execute(&s.pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS settlement_meta (
                key   TEXT PRIMARY KEY,
                value BIGINT NOT NULL
            )
            "#,
        )
        .execute(&s.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO settlement_meta (key, value) VALUES ('settled_count', 0) ON CONFLICT (key) DO NOTHING",
        )
        .execute(&s.pool)
        .await
        .unwrap();
        // Reset state before each test.
        sqlx::query("TRUNCATE settlement")
            .execute(&s.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE settlement_meta SET value = 0 WHERE key = 'settled_count'")
            .execute(&s.pool)
            .await
            .unwrap();
        Some(s)
    }

    /// Seed a settled row directly (no upsert on the read store — the indexer owns writes).
    async fn insert_row(pool: &PgPool, tx_digest: &str, ts: i64, party_b: Option<&str>) {
        sqlx::query(
            r#"
            INSERT INTO settlement (tx_digest, kind, tunnel_id, party_a_addr, party_b_addr,
                party_a_balance, party_b_balance, final_nonce, transcript_root, proof_url,
                walrus_blob_id, checkpoint, timestamp_ms, closed_at_ms, game)
            VALUES ($1,'settled','0xtun','0xa',$2,60,40,3,'aa',NULL,NULL,7,$3,$3,NULL)
            "#,
        )
        .bind(tx_digest)
        .bind(party_b)
        .bind(ts)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn list_keyset_and_address_filter() {
        let Some(s) = store().await else { return };
        for (d, ts) in [("a", 10i64), ("b", 20), ("c", 30)] {
            insert_row(&s.pool, d, ts, Some("0xb")).await;
        }
        let p1 = s
            .list(&SettlementQuery {
                limit: 2,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            p1.rows
                .iter()
                .map(|r| r.tx_digest.clone())
                .collect::<Vec<_>>(),
            ["c", "b"]
        );
        assert_eq!(p1.next_cursor.as_deref(), Some("20:b"));
        let hit = s
            .list(&SettlementQuery {
                limit: 10,
                address: Some("0xb".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(hit.rows.len(), 3);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn settled_count_reads_meta_table() {
        let Some(s) = store().await else { return };
        // Initially 0 (reset by store()).
        assert_eq!(s.settled_count().await.unwrap(), 0);
        // Simulate indexer maintaining the counter at write time.
        sqlx::query("UPDATE settlement_meta SET value = 5 WHERE key = 'settled_count'")
            .execute(&s.pool)
            .await
            .unwrap();
        assert_eq!(
            s.settled_count().await.unwrap(),
            5,
            "reads the maintained counter, not COUNT(*)"
        );
    }
}
