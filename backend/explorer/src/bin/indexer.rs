//! The framework indexer binary: wires the `SettlementPipeline` into a `sui-indexer-alt-framework`
//! `IndexerCluster` (Diesel/Postgres). The framework owns ingestion, watermarks, batching, and
//! shutdown; this binary just configures the cluster and registers the one pipeline.
//!
//! Ingestion source + checkpoint range come from CLI flags parsed into `cluster::Args`
//! (e.g. `--remote-store-url`). Connection + package id come from the environment.
use clap::Parser;
use diesel::sql_types::{Array, Nullable, Text};
use diesel_async::pooled_connection::bb8::Pool;
use diesel_async::pooled_connection::AsyncDieselConnectionManager;
use diesel_async::{AsyncPgConnection, RunQueryDsl};
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use explorer::handler::{SettlementPipeline, PENDING_PROOF_DRAIN_SQL, PENDING_PROOF_UPSERT_SQL};
use fred::prelude::*;
use move_core_types::account_address::AccountAddress;
use sui_indexer_alt_framework::cluster::{Args, IndexerCluster};
use sui_indexer_alt_framework::pipeline::concurrent::ConcurrentConfig;

/// Wire shape published by the control plane on `explorer:proofs`. Camel-case to match the
/// /settle path; only the digest + the two proof fields are relevant here.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProofLink {
    tx_digest: Option<String>,
    walrus_blob_id: Option<String>,
    proof_url: Option<String>,
}

const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    // Do NOT install a tracing subscriber here: `IndexerCluster::build()` installs the framework's
    // own global subscriber (telemetry/metrics), and a second `.init()` panics on boot with
    // "a global default trace dispatcher has already been set". The framework's subscriber honors
    // RUST_LOG. (The `api` binary, which does not use the framework, keeps its own init.)
    let args = Args::parse();
    let package = AccountAddress::from_hex_literal(&std::env::var("TUNNEL_PACKAGE_ID")?)
        .map_err(|e| anyhow::anyhow!("invalid TUNNEL_PACKAGE_ID: {e}"))?;
    let database_url_str = std::env::var("DATABASE_URL")?;
    let database_url: url::Url = database_url_str.parse()?;

    let mut cluster = IndexerCluster::builder()
        .with_database_url(database_url)
        .with_args(args)
        .with_migrations(&MIGRATIONS)
        .build()
        .await?;

    cluster
        .concurrent_pipeline(SettlementPipeline { package }, ConcurrentConfig::default())
        .await?;

    // Redis wiring is additive and best-effort: gated entirely on REDIS_PUBSUB_URL so the indexer
    // still runs against chain-only ingestion without Redis. A bad URL or failed connect is logged
    // and skipped (warn-and-continue) — it never aborts the pipeline. Same posture as EXPLORER_*.
    if let Ok(redis_url) = std::env::var("REDIS_PUBSUB_URL") {
        if let Err(e) = wire_redis(&redis_url, &database_url_str).await {
            tracing::warn!(error = %e, "Redis explorer wiring failed; live feed + proof links disabled");
        }
    }

    // Framework owns watermarks + graceful shutdown; we just wait for the service to finish. The
    // proof subscriber task (spawned in `wire_redis`) runs concurrently for the process lifetime.
    cluster.run().await?.join().await?;
    Ok(())
}

/// Install the live-feed publisher and spawn the proof-link subscriber. Best-effort: any failure
/// here is reported by the caller and never aborts the indexer.
///
/// Two independent Redis roles:
/// - publisher (`RedisClient`): handed to `handler::init_events_publisher` so `commit` can push new
///   settlements to `explorer:events`.
/// - subscriber (`SubscriberClient`): regular `SUBSCRIBE explorer:proofs` (NOT sharded). The
///   control plane PUBLISHes `{txDigest, walrusBlobId, proofUrl}` here when it persists a Walrus
///   proof; we back-fill it onto the chain-sourced row.
async fn wire_redis(redis_url: &str, database_url_str: &str) -> anyhow::Result<()> {
    // Live-feed publisher (Part A): a plain client, init'd, installed into the process global.
    let publisher = Builder::from_config(RedisConfig::from_url(redis_url)?).build()?;
    publisher.init().await?;
    explorer::handler::init_events_publisher(publisher);

    // A standalone diesel-async pool for the proof UPDATEs, separate from the framework's internal
    // pool (the framework's `Connection` is only reachable inside `commit`). Same DATABASE_URL.
    let mgr = AsyncDieselConnectionManager::<AsyncPgConnection>::new(database_url_str);
    let pool: Pool<AsyncPgConnection> = Pool::builder().build(mgr).await?;

    let subscriber = Builder::from_config(RedisConfig::from_url(redis_url)?).build_subscriber_client()?;
    subscriber.init().await?;
    subscriber.subscribe("explorer:proofs").await?;
    let mut messages = subscriber.message_rx();

    // Lives for the process: drains proof links concurrently with `cluster.run()`.
    tokio::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        // Keep the subscriber owned by the task so its connection stays alive for the message_rx.
        let _subscriber = subscriber;
        loop {
            let msg = match messages.recv().await {
                Ok(msg) => msg,
                // A transient lag is NOT end-of-stream: skip the dropped window and keep draining.
                // (The bare `while let Ok` this replaces exited here, silencing proofs until restart.)
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!(skipped = n, "explorer:proofs message_rx lagged; proof links dropped");
                    continue;
                }
                Err(RecvError::Closed) => break,
            };
            let Some(payload) = msg.value.as_string() else {
                continue;
            };
            let link: ProofLink = match serde_json::from_str(&payload) {
                Ok(link) => link,
                Err(e) => {
                    tracing::warn!(error = %e, "explorer:proofs payload not parseable; skipping");
                    continue;
                }
            };
            // Need a digest, and at least one proof field worth recording.
            let Some(digest) = link.tx_digest else { continue };
            if link.proof_url.is_none() && link.walrus_blob_id.is_none() {
                continue;
            }
            let mut conn = match pool.get().await {
                Ok(conn) => conn,
                Err(e) => {
                    tracing::warn!(error = %e, "explorer proof pool exhausted; skipping link");
                    continue;
                }
            };
            // Record the proof durably FIRST, then drain it onto the settlement row — which usually
            // does NOT exist yet (the proof beats the chain-ingested close row). The indexer commit
            // runs the SAME drain after it writes a row, so the link attaches in either arrival
            // order. Best-effort: log and keep draining on error.
            if let Err(e) = diesel::sql_query(PENDING_PROOF_UPSERT_SQL)
                .bind::<Text, _>(digest.clone())
                .bind::<Nullable<Text>, _>(link.proof_url)
                .bind::<Nullable<Text>, _>(link.walrus_blob_id)
                .execute(&mut conn)
                .await
            {
                tracing::warn!(error = %e, %digest, "explorer pending_proof upsert failed");
                continue;
            }
            if let Err(e) = diesel::sql_query(PENDING_PROOF_DRAIN_SQL)
                .bind::<Array<Text>, _>(vec![digest.clone()])
                .execute(&mut conn)
                .await
            {
                tracing::warn!(error = %e, %digest, "explorer proof drain failed");
            }
        }
        tracing::warn!("explorer:proofs subscription closed; proof links disabled until restart");
    });

    Ok(())
}
