//! tunnel-manager — Dopamint Arena control-plane backend (DOP-170).
//! Off the per-move path (ADR-0001): registry + settlement + Walrus + stats only.

mod config;
mod error;
mod mp;
mod routes;
mod state;
mod stats;
mod stats_counter;
mod store;
mod sui;
mod walrus;

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use uuid::Uuid;

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

    let instance_id = config
        .instance_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let (stats_tx, _) = broadcast::channel::<String>(16);

    let (control, mp, bus): (
        Arc<dyn store::ControlStore>,
        Arc<dyn store::MpStore>,
        Arc<dyn store::Bus>,
    ) = if let Some(cache_url) = config.redis_cache_url.clone() {
        let pubsub_url = Config::require("REDIS_PUBSUB_URL", &config.redis_pubsub_url)?.to_string();
        let cache = store::redis::connect(&cache_url).await?;
        let pubsub = store::redis::connect(&pubsub_url).await?;
        (
            Arc::new(store::redis::RedisControlStore::new(cache.clone())),
            Arc::new(store::redis::RedisMpStore::new(cache)),
            Arc::new(store::redis::RedisBus::new(instance_id.clone(), pubsub).await?),
        )
    } else {
        (
            Arc::new(store::memory::InMemoryControlStore::default()),
            Arc::new(store::memory::InMemoryMpStore::default()),
            Arc::new(store::memory::LocalBus::new(instance_id.clone())),
        )
    };

    let pair_hold_ms = std::env::var("MP_PAIR_HOLD_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(750);
    let state: SharedState = Arc::new(AppState {
        control,
        mp,
        bus,
        settler,
        walrus,
        stats_tx,
        actions: crate::stats_counter::LocalActionCounter::default(),
        pair_hold_ms,
        pairing: crate::stats_counter::MatchPairingMetrics::default(),
    });
    stats::spawn_stats_broadcaster(state.clone());
    spawn_action_flusher(state.clone());
    sui::spawn_event_indexer(state.clone());

    // Clone before `state` is consumed by `.with_state` so we can flush after shutdown.
    let flush_state = state.clone();
    let app = Router::new()
        .route("/healthz", get(routes::health))
        .route("/health/live", get(routes::live))
        .route("/health/ready", get(routes::ready))
        .route("/metrics", get(routes::metrics))
        .route("/v1/sessions", post(routes::register_session))
        .route("/v1/sessions/:id/heartbeat", post(routes::heartbeat))
        .route("/v1/tunnels/:tunnel_id/settle", post(routes::settle))
        .route("/v1/stats/live", get(routes::stats_live))
        .route("/v1/mp", get(crate::mp::ws::mp_upgrade))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!(%bind_addr, "tunnel-manager listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    // Graceful shutdown completed: push the last sub-second of counted moves so a clean
    // rollout doesn't drop them (the 1 Hz flusher is gone with the runtime by now).
    flush_actions(&flush_state).await;
    Ok(())
}

/// Drain the per-instance move counter into ControlStore once. At-most-once by design: the
/// watermark advances at drain time, so a failed push loses ≤1 interval of display counts and
/// never double-counts. Used both by the 1 Hz flusher and the shutdown drain.
async fn flush_actions(state: &SharedState) {
    for (game, delta) in state.actions.drain_deltas() {
        state.control.add_actions(&game, delta).await;
    }
}

/// Drain the per-instance move counter into ControlStore once per second (no Redis round trip
/// per move). Lossy-by-design on crash: ≤1s of display counts.
fn spawn_action_flusher(state: SharedState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tick.tick().await;
            flush_actions(&state).await;
        }
    });
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

#[cfg(test)]
mod flush_tests {
    use super::*;

    #[tokio::test]
    async fn flush_actions_drains_counter_into_control_store() {
        let state = crate::state::AppState::in_memory_for_test();
        state.actions.incr("ttt", 3);
        state.actions.incr("ttt", 2);
        flush_actions(&state).await;
        assert_eq!(
            state.control.snapshot().await.per_game["ttt"].total_actions,
            5
        );
        // Nothing new since the last drain → a second flush adds nothing.
        flush_actions(&state).await;
        assert_eq!(
            state.control.snapshot().await.per_game["ttt"].total_actions,
            5
        );
    }
}
