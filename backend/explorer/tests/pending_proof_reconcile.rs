//! Order-independent Walrus proof reconciliation (`pending_proof`), exercised against a LIVE
//! Postgres in BOTH arrival orders using the REAL `PENDING_PROOF_UPSERT_SQL` /
//! `PENDING_PROOF_DRAIN_SQL` the indexer + commit run. This is the only test that proves the
//! headline fix (a proof published before its settlement row is ingested must not be lost), since
//! the behavior is pure SQL invisible to the unit tests.
//!
//! Gated on TEST_DATABASE_URL. Apply migrations first, then run --ignored:
//!   diesel migration run --database-url "$TEST_DATABASE_URL" --migration-dir backend/explorer/migrations
//!   TEST_DATABASE_URL=... cargo test -p explorer --test pending_proof_reconcile -- --ignored

use diesel::sql_types::{Array, BigInt, Nullable, Text};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use explorer::handler::{PENDING_PROOF_DRAIN_SQL, PENDING_PROOF_UPSERT_SQL};

#[derive(diesel::QueryableByName)]
struct ProofCols {
    #[diesel(sql_type = Nullable<Text>)]
    proof_url: Option<String>,
    #[diesel(sql_type = Nullable<Text>)]
    walrus_blob_id: Option<String>,
}

#[derive(diesel::QueryableByName)]
struct Count {
    #[diesel(sql_type = BigInt)]
    n: i64,
}

async fn connect() -> Option<AsyncPgConnection> {
    let url = std::env::var("TEST_DATABASE_URL").ok()?;
    Some(
        AsyncPgConnection::establish(&url)
            .await
            .expect("connect TEST_DATABASE_URL"),
    )
}

async fn cleanup(c: &mut AsyncPgConnection, digest: &str) {
    for sql in [
        "DELETE FROM settlement WHERE tx_digest = $1",
        "DELETE FROM pending_proof WHERE tx_digest = $1",
    ] {
        diesel::sql_query(sql)
            .bind::<Text, _>(digest)
            .execute(c)
            .await
            .unwrap();
    }
}

async fn upsert_pending(c: &mut AsyncPgConnection, digest: &str, url: &str, blob: &str) {
    diesel::sql_query(PENDING_PROOF_UPSERT_SQL)
        .bind::<Text, _>(digest)
        .bind::<Nullable<Text>, _>(Some(url.to_string()))
        .bind::<Nullable<Text>, _>(Some(blob.to_string()))
        .execute(c)
        .await
        .unwrap();
}

async fn drain(c: &mut AsyncPgConnection, digest: &str) {
    diesel::sql_query(PENDING_PROOF_DRAIN_SQL)
        .bind::<Array<Text>, _>(vec![digest.to_string()])
        .execute(c)
        .await
        .unwrap();
}

async fn insert_settled_row(c: &mut AsyncPgConnection, digest: &str) {
    diesel::sql_query(
        "INSERT INTO settlement (tx_digest, kind, tunnel_id, checkpoint, timestamp_ms) \
         VALUES ($1, 'settled', '0xtun', 1, 1)",
    )
    .bind::<Text, _>(digest)
    .execute(c)
    .await
    .unwrap();
}

async fn proof_of(c: &mut AsyncPgConnection, digest: &str) -> Option<ProofCols> {
    diesel::sql_query("SELECT proof_url, walrus_blob_id FROM settlement WHERE tx_digest = $1")
        .bind::<Text, _>(digest)
        .get_result::<ProofCols>(c)
        .await
        .ok()
}

async fn pending_count(c: &mut AsyncPgConnection, digest: &str) -> i64 {
    diesel::sql_query("SELECT COUNT(*)::bigint AS n FROM pending_proof WHERE tx_digest = $1")
        .bind::<Text, _>(digest)
        .get_result::<Count>(c)
        .await
        .unwrap()
        .n
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn proof_before_row_is_not_lost() {
    let Some(mut c) = connect().await else { return };
    let d = "e2e_proof_before_row";
    cleanup(&mut c, d).await;

    // Proof arrives FIRST (the common, previously-broken case): record it durably, then drain —
    // which finds no settlement row yet, so the proof must be RETAINED (not dropped).
    upsert_pending(&mut c, d, "https://walrus/url", "blob123").await;
    drain(&mut c, d).await;
    assert_eq!(
        pending_count(&mut c, d).await,
        1,
        "proof retained in pending_proof until its row exists"
    );
    assert!(proof_of(&mut c, d).await.is_none(), "no settlement row yet");

    // The chain-ingested row commits LATER and runs the SAME drain.
    insert_settled_row(&mut c, d).await;
    drain(&mut c, d).await;

    let p = proof_of(&mut c, d).await.expect("settlement row present");
    assert_eq!(
        p.proof_url.as_deref(),
        Some("https://walrus/url"),
        "proof link attached to the row after it arrived"
    );
    assert_eq!(p.walrus_blob_id.as_deref(), Some("blob123"));
    assert_eq!(
        pending_count(&mut c, d).await,
        0,
        "pending drained once merged"
    );
    cleanup(&mut c, d).await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn row_before_proof_also_enriches() {
    let Some(mut c) = connect().await else { return };
    let d = "e2e_row_before_proof";
    cleanup(&mut c, d).await;

    // Row commits FIRST with no proof; its commit drain finds nothing pending — no-op.
    insert_settled_row(&mut c, d).await;
    drain(&mut c, d).await;
    assert!(
        proof_of(&mut c, d).await.unwrap().proof_url.is_none(),
        "no proof yet"
    );

    // Proof arrives later: upsert pending, then drain attaches it immediately.
    upsert_pending(&mut c, d, "https://walrus/late", "blobLate").await;
    drain(&mut c, d).await;

    let p = proof_of(&mut c, d).await.unwrap();
    assert_eq!(p.proof_url.as_deref(), Some("https://walrus/late"));
    assert_eq!(pending_count(&mut c, d).await, 0);
    cleanup(&mut c, d).await;
}
