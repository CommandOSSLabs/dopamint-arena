//! The framework indexer binary: wires the `SettlementPipeline` into a `sui-indexer-alt-framework`
//! `IndexerCluster` (Diesel/Postgres). The framework owns ingestion, watermarks, batching, and
//! shutdown; this binary just configures the cluster and registers the one pipeline.
//!
//! Ingestion source + checkpoint range come from CLI flags parsed into `cluster::Args`
//! (e.g. `--remote-store-url`). Connection + package id come from the environment.
use clap::Parser;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use explorer::handler::SettlementPipeline;
use move_core_types::account_address::AccountAddress;
use sui_indexer_alt_framework::cluster::{Args, IndexerCluster};
use sui_indexer_alt_framework::pipeline::concurrent::ConcurrentConfig;

const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args = Args::parse();
    let package = AccountAddress::from_hex_literal(&std::env::var("TUNNEL_PACKAGE_ID")?)
        .map_err(|e| anyhow::anyhow!("invalid TUNNEL_PACKAGE_ID: {e}"))?;
    let database_url: url::Url = std::env::var("DATABASE_URL")?.parse()?;

    let mut cluster = IndexerCluster::builder()
        .with_database_url(database_url)
        .with_args(args)
        .with_migrations(&MIGRATIONS)
        .build()
        .await?;

    cluster
        .concurrent_pipeline(SettlementPipeline { package }, ConcurrentConfig::default())
        .await?;

    // Framework owns watermarks + graceful shutdown; we just wait for the service to finish.
    cluster.run().await?.join().await?;
    Ok(())
}
