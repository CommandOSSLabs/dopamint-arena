//! tunnel-manager — Dopamint Arena control-plane backend (DOP-170).
//! Off the per-move path (ADR-0001): registry + settlement + Walrus + stats only.

mod chat_store;
mod config;
mod enoki;
mod error;
mod fleet;
mod mp;
mod ollama;
mod routes;
mod settle_batch;
mod settle_queue;
mod settle_worker;
mod state;
mod stats;
mod stats_counter;
mod store;
mod sui;
mod sui_rpc;
mod wallet;
mod walrus;

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::Router;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
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

    // One governed RPC client for all fullnode traffic (settler + arena opener): a single
    // process-wide throttle + retry/backoff against the one rate-limited node.
    let governed_rpc = sui_rpc::GovernedRpc::new(
        Config::require("SUI_RPC_URL", &config.sui_rpc_url)?.to_string(),
        config.rpc_limits(),
    );
    let settler = Arc::new(sui::SuiSettler::new(
        governed_rpc.clone(),
        Config::require("TUNNEL_PACKAGE_ID", &config.package_id)?,
        &config.coin_type,
        config.agent_allowance_package_id.as_deref(),
        config.streaming_payment_package_id.as_deref(),
        Config::require("SUI_SETTLER_KEY", &config.settler_key)?,
        config.mtps_admin_cap_id.as_deref(),
    )?);
    // Enoki is the primary gas sponsor when configured; the settler above is the fallback (ADR-0014).
    // The settler's close/fallback path pins a hard-coded testnet genesis digest (`sui.rs`), so guard
    // against a mainnet-Enoki / testnet-settler split-brain until that digest is config-driven.
    let enoki = match config.enoki_api_key.clone() {
        Some(key) => {
            anyhow::ensure!(
                config.sui_network == "testnet",
                "SUI_NETWORK must be 'testnet' (the settler fallback's chain digest is testnet-pinned); got {}",
                config.sui_network
            );
            tracing::info!(network = %config.sui_network, "enoki sponsor enabled (settler is the fallback)");
            Some(enoki::EnokiClient::new(
                key,
                config.sui_network.clone(),
                enoki::ENOKI_BASE_URL,
            )?)
        }
        None => {
            tracing::info!("enoki not configured; using settler-only gas sponsorship");
            None
        }
    };
    let walrus = walrus::WalrusClient::new(
        Config::require("WALRUS_PUBLISHER_URL", &config.walrus_publisher_url)?.to_string(),
        Config::require("WALRUS_AGGREGATOR_URL", &config.walrus_aggregator_url)?.to_string(),
    );
    let ollama = crate::ollama::OllamaClient::new(
        config
            .ollama_url
            .clone()
            .unwrap_or_else(|| "http://localhost:11434".into()),
        config
            .ollama_model
            .clone()
            .unwrap_or_else(|| "qwen2.5:1.5b".into()),
    )?;

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

    // Funded seat-B wallet pool (PR #124): opened once if WALLET_POOL_ID is set, else None (bots use
    // the placeholder identity, the off-chain/Noop dev path). Same RPC + network as the settler. A
    // failed open (bad S3/passphrase/IAM) must NOT take down the whole backend — only arena opens lose
    // funded seat-B; faucet/settle/stats stay up. Degrade to None (Noop opener) and log loudly.
    let wallet_pool = match crate::wallet::build(
        config.wallet_pool_id.as_deref(),
        config.wallet_pool_access_value.as_deref(),
        config.wallet_pool_funded_count,
        config.sui_rpc_url.as_deref().unwrap_or_default(),
        if config.sui_network == "mainnet" {
            wallet_pool::Network::Mainnet
        } else {
            wallet_pool::Network::Testnet
        },
    )
    .await
    {
        Ok(pool) => pool.map(Arc::new),
        Err(e) => {
            tracing::error!(
                "wallet pool open failed — arena opener falls back to Noop/placeholder: {e:#}"
            );
            None
        }
    };

    // Arena opener (ADR-0028): the real `SuiArenaOpener` — each open self-signs create + fund-seat-B as
    // the checked-out pool member — when the wallet pool + on-chain package/RPC are configured; else
    // `Noop` so the allocate contract + FE deposit path still work for tests/dev without the pool.
    let arena_opener: Arc<dyn crate::fleet::arena_opener::ArenaTunnelOpener> = match (
        &wallet_pool,
        &config.sui_rpc_url,
        &config.package_id,
    ) {
        (Some(pool), Some(rpc), Some(pkg)) => Arc::new(
            crate::fleet::arena_opener::SuiArenaOpener::new(
                rpc.clone(),
                pkg,
                &config.coin_type,
                pool.clone(),
            )
            .map_err(|e| anyhow::anyhow!("arena opener build: {e:#}"))?,
        ),
        _ => {
            tracing::info!(
                    "arena opener: Noop (set WALLET_POOL_ID + SUI_RPC_URL + TUNNEL_PACKAGE_ID for real on-chain opens)"
                );
            Arc::new(crate::fleet::arena_opener::NoopArenaOpener)
        }
    };

    // Durable settle queue (ADR-0029): `/settle` enqueues here and returns 202; the worker pool
    // below drains it into batched PTBs. Single-instance in-memory today; a Redis-stream impl
    // (`RedisSettleQueue`) plugs into this seam for HA durability without touching the handler.
    let settle_queue: Arc<dyn settle_queue::SettleQueue> =
        Arc::new(settle_queue::InMemorySettleQueue::default());

    let state: SharedState = Arc::new(AppState {
        control,
        mp,
        bus,
        settler,
        settle_queue,
        enoki,
        walrus,
        ollama,
        stats_tx,
        actions: crate::stats_counter::LocalActionCounter::default(),
        pair_hold_ms,
        pairing: crate::stats_counter::MatchPairingMetrics::default(),
        chat: crate::chat_store::ChatTranscriptStore::new(),
        fleet: crate::fleet::BotPool::default(),
        arena_opener,
        arena: crate::fleet::arena_rendezvous::ArenaRendezvous::default(),
        arena_fleet_count: config.colocated_fleet_count,
        arena_fleet_games: config.colocated_fleet_games.iter().cloned().collect(),
        wallet_pool,
        faucet_user_amount: config.faucet_user_amount,
        faucet_internal_amount: config.faucet_internal_amount,
        faucet_cooldown_secs: config.faucet_cooldown_secs,
        faucet_max_per_window: config.faucet_max_per_window,
        faucet_admin_token: config.faucet_admin_token.clone(),
    });
    stats::spawn_stats_broadcaster(state.clone());
    spawn_action_flusher(state.clone());

    // Settle-worker pool (ADR-0029): N workers drain the settle queue, each coalescing a claim
    // into ONE batched `close_cooperative_with_root` PTB through the governed RPC. The worker count
    // + batch size are the tuning knobs for living under the fullnode's rate ceiling.
    let settle_workers: usize = std::env::var("SETTLE_WORKERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or(4);
    let settle_batch_max: usize = std::env::var("SETTLE_BATCH_MAX")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or(128);
    let settle_flush_ms: u64 = std::env::var("SETTLE_BATCH_FLUSH_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100);
    for i in 0..settle_workers {
        let deps = settle_worker::SettleWorkerDeps {
            queue: state.settle_queue.clone(),
            settler: state.settler.clone(),
            control: state.control.clone(),
            walrus: state.walrus.clone(),
            bus: state.bus.clone(),
        };
        tokio::spawn(settle_worker::run_settle_worker(
            deps,
            format!("settle-{i}"),
            settle_batch_max,
            settle_flush_ms,
        ));
    }
    tracing::info!(
        workers = settle_workers,
        batch_max = settle_batch_max,
        flush_ms = settle_flush_ms,
        "settle-worker pool started"
    );
    // Co-located fleet (ADR-0027): bots are spawned on demand by `arena_allocate`
    // (`reserve_or_spawn`), bounded by `arena_fleet_count`/`arena_fleet_games` on `AppState` — no
    // startup pre-spawn. Inert unless `FLEET_COLOCATED_COUNT > 0`.
    // Poll-index on-chain tunnel events (Created/Activated/Closed) into recent_events so the
    // live feed reflects real settlements; without this the stats SSE never emits any.
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
        // Settlement carries the off-chain transcript as a v2 binary body (one fixed 250 B entry
        // per co-signed move), archived to Walrus verbatim. Maximizing moves/tunnel amortizes the
        // on-chain close and Walrus per-blob cost, so a long self-play game ships tens of thousands
        // of moves. 32 MB for /settle only (≈134k moves) caps tunnel length; the body streams to
        // Walrus by reference (Bytes), so it stays 1× in memory (canonical MAX_MOVES_PER_TUNNEL=100k
        // ≈ 25 MB sits well inside this).
        .route(
            "/v1/tunnels/:tunnel_id/settle",
            // No concurrency limit (ADR-0029): ingest is O(1) (validate + enqueue), so a fleet
            // burst is absorbed as queue depth, not bounded here. The worker pool + governed RPC are
            // the real load bounds. Body cap stays so an oversized transcript can't exhaust memory.
            post(routes::settle).layer(DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/v1/sponsor", post(routes::sponsor))
        // MTPS faucet (ADR-0023): the public route is per-address rate limited; the internal route
        // is unlimited and bearer-gated (fails closed when FAUCET_ADMIN_TOKEN is unset).
        .route("/v1/faucet", post(routes::faucet))
        .route("/v1/faucet/internal", post(routes::faucet_admin))
        .route("/v1/chat", post(routes::chat))
        .route("/v1/chat/topic", get(routes::chat_topic))
        .route("/v1/chat/live/publish", post(routes::chat_publish))
        .route("/v1/chat/live", get(routes::chat_live))
        .route("/v1/stats/live", get(routes::stats_live))
        .route("/v1/sponsor/execute", post(routes::sponsor_execute))
        .route("/v1/mp", get(crate::mp::ws::mp_upgrade))
        // Arena one-signature flow (ADR-0026): reserve warm bots, then map opened tunnels back to
        // each bot so it deposits its seat. `/v1/fleet` is the bot's control socket into the pool.
        .route("/v1/arena/allocate", post(routes::arena_allocate))
        .route("/v1/arena/opened", post(routes::arena_opened))
        .route("/v1/fleet", get(crate::fleet::ws::fleet_upgrade))
        .layer(TraceLayer::new_for_http())
        .layer(cors_layer())
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
