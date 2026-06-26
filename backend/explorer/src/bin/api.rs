//! Read-only explorer API service (deploy autoscaled). Serves the SettlementStore over HTTP
//! and fans out live rows from Redis `explorer:events` as SSE. Verification is client-side.

use std::convert::Infallible;
use std::sync::Arc;

use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use fred::prelude::*;
use futures::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
use tower_http::cors::{Any, CorsLayer};

use explorer::api::{router, ApiState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")?;
    let store = Arc::new(shared::postgres::PgSettlementStore::connect(&database_url).await?);
    let state = ApiState {
        store,
        walrus_aggregator_url: std::env::var("WALRUS_AGGREGATOR_URL")
            .unwrap_or_else(|_| "https://aggregator.walrus-testnet.walrus.space".into()),
        http: reqwest::Client::new(),
    };

    // Bridge Redis pub/sub -> a broadcast channel the SSE handler subscribes to.
    // `SubscriberClient` (not the base `Client`) owns the message stream.
    // `_rx` is held here intentionally: without at least one receiver the channel reports
    // zero receivers and the first `tx.send` would silently fail before any SSE client connects.
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(256);
    if let Ok(url) = std::env::var("REDIS_PUBSUB_URL") {
        let sub = Builder::from_config(RedisConfig::from_url(&url)?).build_subscriber_client()?;
        sub.init().await?;
        sub.subscribe("explorer:events").await?;
        let mut messages = sub.message_rx();
        let tx2 = tx.clone();
        tokio::spawn(async move {
            use tokio::sync::broadcast::error::RecvError;
            loop {
                match messages.recv().await {
                    Ok(msg) => {
                        if let Some(s) = msg.value.as_string() {
                            let _ = tx2.send(s);
                        }
                    }
                    // Transient lag is NOT end-of-stream: skip the dropped window and keep bridging.
                    // (The bare `while let Ok` this replaces exited here, silencing the feed forever.)
                    Err(RecvError::Lagged(n)) => {
                        tracing::warn!(
                            skipped = n,
                            "explorer:events message_rx lagged; live rows dropped"
                        );
                    }
                    Err(RecvError::Closed) => break,
                }
            }
            tracing::warn!(
                "Redis explorer:events subscription closed; SSE live feed silent until restart"
            );
        });
    }

    // Second bridge: stats:snapshot -> stats_tx, relayed to /v1/stats/live. N tunnel-manager
    // instances publish ~identical snapshots, so SSE viewers see a few duplicate frames/tick;
    // the frontend overwrites state idempotently, so this is harmless. `_stats_rx` is held for
    // the same reason as `_rx` above (keep the channel from reporting zero receivers).
    let (stats_tx, _stats_rx) = tokio::sync::broadcast::channel::<String>(256);
    if let Ok(url) = std::env::var("REDIS_PUBSUB_URL") {
        let sub = Builder::from_config(RedisConfig::from_url(&url)?).build_subscriber_client()?;
        sub.init().await?;
        sub.subscribe("stats:snapshot").await?;
        let mut messages = sub.message_rx();
        let tx2 = stats_tx.clone();
        tokio::spawn(async move {
            use tokio::sync::broadcast::error::RecvError;
            let _sub = sub;
            loop {
                match messages.recv().await {
                    Ok(msg) => {
                        if let Some(s) = msg.value.as_string() {
                            let _ = tx2.send(s);
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        tracing::warn!(
                            skipped = n,
                            "stats:snapshot message_rx lagged; live samples dropped"
                        );
                    }
                    Err(RecvError::Closed) => break,
                }
            }
            tracing::warn!(
                "Redis stats:snapshot subscription closed; SSE live stats silent until restart"
            );
        });
    }

    let sse_tx = tx.clone();
    let stats_sse_tx = stats_tx.clone();
    let app = router(state)
        .route(
            "/v1/explorer/stream",
            get(move || {
                let rx = sse_tx.subscribe();
                async move {
                    let stream = BroadcastStream::new(rx).filter_map(|m| async move {
                        m.ok()
                            .map(|json| Ok::<_, Infallible>(Event::default().data(json)))
                    });
                    Sse::new(stream).keep_alive(KeepAlive::default())
                }
            }),
        )
        .route(
            "/v1/stats/live",
            get(move || {
                let rx = stats_sse_tx.subscribe();
                async move {
                    let stream = BroadcastStream::new(rx).filter_map(|m| async move {
                        m.ok()
                            .map(|json| Ok::<_, Infallible>(Event::default().data(json)))
                    });
                    Sse::new(stream).keep_alive(KeepAlive::default())
                }
            }),
        )
        .layer(cors_layer());

    let addr = std::env::var("EXPLORER_API_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "explorer-api listening");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Build a CORS layer from `CORS_ALLOWED_ORIGINS`. When the env var is set, only the listed
/// comma-separated origins are allowed; otherwise the layer remains permissive for local dev.
fn cors_layer() -> CorsLayer {
    match std::env::var("CORS_ALLOWED_ORIGINS") {
        Ok(origins) if !origins.is_empty() => {
            let origins: Vec<http::HeaderValue> = origins
                .split(',')
                .map(|s| {
                    s.trim()
                        .parse()
                        .expect("invalid CORS_ALLOWED_ORIGINS value")
                })
                .collect();
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods(Any)
                .allow_headers(Any)
        }
        _ => CorsLayer::permissive(),
    }
}
