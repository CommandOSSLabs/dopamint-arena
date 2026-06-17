//! tunnel-manager — Dopamint Arena control-plane backend (DOP-170).
//! Off the per-move path (ADR-0001): registry + settlement + Walrus + stats only.

mod config;
mod error;
mod mp;
mod routes;
mod state;
mod stats;
mod sui;
mod walrus;

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use tokio::sync::broadcast;
use tower_http::trace::TraceLayer;

use crate::config::Config;
use crate::state::{AppState, SharedState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=debug".into()),
        )
        .init();

    let config = Config::from_env()?;
    let bind_addr = config.bind_addr.clone();

    // Phase 1: the settler is required to serve /settle — fail loud at startup naming
    // any missing var, rather than 500ing on the first settlement.
    let settler = sui::SuiSettler::new(
        Config::require("SUI_RPC_URL", &config.sui_rpc_url)?.to_string(),
        Config::require("TUNNEL_PACKAGE_ID", &config.package_id)?,
        &config.coin_type,
        Config::require("SUI_SETTLER_KEY", &config.settler_key)?,
    )?;
    let walrus = walrus::WalrusClient::new(
        Config::require("WALRUS_PUBLISHER_URL", &config.walrus_publisher_url)?.to_string(),
        Config::require("WALRUS_AGGREGATOR_URL", &config.walrus_aggregator_url)?.to_string(),
    );

    let (stats_tx, _) = broadcast::channel::<String>(16);
    let state: SharedState = Arc::new(AppState {
        sessions: std::sync::RwLock::new(std::collections::HashMap::new()),
        total_actions: std::sync::atomic::AtomicU64::new(0),
        active_tunnels: std::sync::atomic::AtomicU64::new(0),
        settled_tunnels: std::sync::atomic::AtomicU64::new(0),
        tunnels: std::sync::RwLock::new(std::collections::HashMap::new()),
        per_game_actions: std::sync::RwLock::new(std::collections::HashMap::new()),
        settler,
        walrus,
        stats_tx,
        presence: std::sync::RwLock::new(std::collections::HashMap::new()),
        queues: std::sync::RwLock::new(std::collections::HashMap::new()),
        invites: std::sync::RwLock::new(std::collections::HashMap::new()),
        matches: std::sync::RwLock::new(std::collections::HashMap::new()),
        conns: std::sync::RwLock::new(std::collections::HashMap::new()),
    });
    stats::spawn_stats_broadcaster(state.clone());
    sui::spawn_event_indexer(state.clone());

    let app = Router::new()
        .route("/healthz", get(routes::health))
        .route("/metrics", get(routes::metrics))
        .route("/v1/sessions", post(routes::register_session))
        .route("/v1/sessions/:id/heartbeat", post(routes::heartbeat))
        .route("/v1/sessions/:id/settle", post(routes::settle))
        .route("/v1/stats/live", get(routes::stats_live))
        .route("/v1/mp", get(crate::mp::ws::mp_upgrade))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!(%bind_addr, "tunnel-manager listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Resolve on SIGINT (Ctrl-C) or SIGTERM so the orchestrator can roll the service cleanly.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
    tracing::info!("shutdown signal received; draining");
}
