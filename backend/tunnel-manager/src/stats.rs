//! The stats broadcaster: compute the aggregate snapshot ONCE per tick and fan it
//! out to every SSE subscriber, so cost scales with the audience, not with TPS.

use crate::state::SharedState;

/// Recompute the aggregate snapshot once per tick and broadcast it to every SSE
/// subscriber. `tps` is INSTANTANEOUS (delta over the tick), not a lifetime average.
pub(crate) fn spawn_stats_broadcaster(state: SharedState) {
    const TICK_MS: u64 = 500;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(TICK_MS));
        let mut prev_total = 0u64;
        loop {
            interval.tick().await;
            let mut snap = state.control.snapshot().await;
            let cur = snap.total_actions;
            snap.tps = cur.saturating_sub(prev_total) * (1000 / TICK_MS);
            prev_total = cur;
            if let Ok(json) = serde_json::to_string(&snap) {
                let _ = state.stats_tx.send(json);
            }
        }
    });
}
