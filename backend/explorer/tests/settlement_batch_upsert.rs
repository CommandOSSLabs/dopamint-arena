//! One transaction (one PTB) can open or settle MANY tunnels — each emits its own lifecycle
//! event under the SAME tx_digest. The indexer batches a checkpoint's rows into one
//! `INSERT … ON CONFLICT … DO UPDATE`, so the row identity MUST be (tx_digest, tunnel_id); keying
//! on tx_digest alone makes Postgres reject the whole batch ("ON CONFLICT DO UPDATE command cannot
//! affect row a second time") and freezes the pipeline watermark. This drives the REAL production
//! `upsert_settlement_batch` against a live Postgres, so it catches both the schema PK and the
//! ON CONFLICT target.
//!
//! Gated on TEST_DATABASE_URL. Apply migrations first, then run --ignored:
//!   diesel migration run --database-url "$TEST_DATABASE_URL" --migration-dir backend/explorer/migrations
//!   TEST_DATABASE_URL=... cargo test -p explorer --test settlement_batch_upsert -- --ignored

use diesel::sql_types::{BigInt, Text};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use explorer::handler::{upsert_settlement_batch, StoredSettlement};

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
    diesel::sql_query("DELETE FROM settlement WHERE tx_digest = $1")
        .bind::<Text, _>(digest)
        .execute(c)
        .await
        .unwrap();
}

async fn row_count(c: &mut AsyncPgConnection, digest: &str) -> i64 {
    diesel::sql_query("SELECT COUNT(*)::bigint AS n FROM settlement WHERE tx_digest = $1")
        .bind::<Text, _>(digest)
        .get_result::<Count>(c)
        .await
        .unwrap()
        .n
}

fn settled_row(digest: &str, tunnel: &str) -> StoredSettlement {
    StoredSettlement {
        tx_digest: digest.into(),
        kind: "settled".into(),
        tunnel_id: tunnel.into(),
        party_a_addr: None,
        party_b_addr: None,
        party_a_balance: Some(60),
        party_b_balance: Some(40),
        final_nonce: Some(1),
        transcript_root: None,
        checkpoint: 1,
        timestamp_ms: 1,
        closed_at_ms: Some(1),
    }
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL"]
async fn batched_close_of_two_tunnels_in_one_tx_persists_both() {
    let Some(mut c) = connect().await else { return };
    let d = "e2e_batch_multi_tunnel";
    cleanup(&mut c, d).await;

    // Two tunnels closed in one PTB -> two TunnelClosed events sharing one tx_digest.
    let rows = vec![settled_row(d, "0xtun_a"), settled_row(d, "0xtun_b")];
    upsert_settlement_batch(&rows, &mut c)
        .await
        .expect("batched upsert of two tunnels sharing one tx_digest must succeed");

    assert_eq!(
        row_count(&mut c, d).await,
        2,
        "both per-tunnel rows from the one tx must be stored"
    );
    cleanup(&mut c, d).await;
}
