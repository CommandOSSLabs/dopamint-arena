//! The stats broadcaster: compute the aggregate snapshot ONCE per tick and fan it
//! out to every SSE subscriber, so cost scales with the audience, not with TPS.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::state::{AppState, GameStat, SharedState, StatsSnapshot};

/// Recompute the aggregate snapshot once per tick and broadcast it to every SSE
/// subscriber. `tps` is INSTANTANEOUS (delta over the tick), not a lifetime average.
pub(crate) fn spawn_stats_broadcaster(state: SharedState) {
    const TICK_MS: u64 = 500;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(TICK_MS));
        let mut prev_total = 0u64;
        loop {
            interval.tick().await;
            let cur_total = state.total_actions.load(Ordering::Relaxed);
            let tps = cur_total.saturating_sub(prev_total) * (1000 / TICK_MS);
            prev_total = cur_total;
            if let Ok(json) = serde_json::to_string(&build_snapshot(&state, tps)) {
                // Err only means "no subscribers right now" — fine to drop.
                let _ = state.stats_tx.send(json);
            }
        }
    });
}

/// Aggregate the in-memory registry into a panel snapshot. `tps` is supplied by the
/// broadcaster (computed from the per-tick delta).
pub(crate) fn build_snapshot(state: &AppState, tps: u64) -> StatsSnapshot {
    let sessions = state.sessions.read().expect("sessions lock");
    let per_game_actions = state.per_game_actions.read().expect("per_game lock");
    let mut per_game: HashMap<String, GameStat> = HashMap::new();
    for rec in sessions.values() {
        // Per-game tunnel count stays session-derived (game grouping is off-chain).
        // `tps` here stays 0 (the broadcaster fills per-game rate from per-tick deltas).
        let entry = per_game.entry(rec.game.clone()).or_insert(GameStat {
            tps: 0,
            tunnels: 0,
            total_actions: 0,
        });
        entry.tunnels += rec.tunnels.len() as u64;
        entry.total_actions = per_game_actions.get(&rec.game).copied().unwrap_or(0);
    }
    StatsSnapshot {
        tps,
        total_actions: state.total_actions.load(Ordering::Relaxed),
        // Top-line counts are event-authoritative, maintained at write time by the indexer.
        active_tunnels: state.active_tunnels.load(Ordering::Relaxed),
        settled_tunnels: state.settled_tunnels.load(Ordering::Relaxed),
        per_game,
    }
}
