//! Per-instance, per-game move counter. The relay hot path increments these in-process
//! (no Redis); a 1/s flusher pushes the delta-since-last-flush into ControlStore so the
//! global counter stays correct without a per-move round trip.
//!
//! At-most-once: `drain_deltas` advances the watermark before the push, so a failed flush
//! (crash OR a Redis error) drops that interval's delta — never double-counts. Undercount-safe
//! by design for display stats. A graceful shutdown runs one final flush (`flush_actions`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

#[derive(Default)]
pub struct LocalActionCounter {
    games: RwLock<HashMap<String, AtomicU64>>,
    flushed: RwLock<HashMap<String, u64>>,
}

impl LocalActionCounter {
    pub fn incr(&self, game: &str, delta: u64) {
        if let Some(c) = self.games.read().unwrap().get(game) {
            c.fetch_add(delta, Ordering::Relaxed);
            return;
        }
        // or_insert_with only runs if the entry is vacant — concurrent losers find
        // the key already inserted and fetch_add on the existing atomic below.
        self.games
            .write()
            .unwrap()
            .entry(game.to_owned())
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(delta, Ordering::Relaxed);
    }

    /// Per-game (game, delta) since the last successful drain. Advances the watermark to
    /// the current cumulative value — callers push the returned deltas to ControlStore.
    pub fn drain_deltas(&self) -> Vec<(String, u64)> {
        let games = self.games.read().unwrap();
        let mut flushed = self.flushed.write().unwrap();
        let mut out = Vec::new();
        for (g, c) in games.iter() {
            let cur = c.load(Ordering::Relaxed);
            let prev = flushed.get(g).copied().unwrap_or(0);
            if cur > prev {
                out.push((g.clone(), cur - prev));
                flushed.insert(g.clone(), cur);
            }
        }
        out
    }
}

/// Per-instance tally of pairing outcomes: both seats on this instance (colocated → in-process
/// relay) vs. split across instances (Redis-fallback relay). Per-instance by design — Prometheus
/// sums these across scraped instances.
#[derive(Default)]
pub struct MatchPairingMetrics {
    colocated: AtomicU64,
    split: AtomicU64,
}

impl MatchPairingMetrics {
    /// Record one freshly created match. `colocated` = both seats share this instance.
    pub fn observe(&self, colocated: bool) {
        if colocated {
            self.colocated.fetch_add(1, Ordering::Relaxed);
        } else {
            self.split.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Cumulative `(colocated, split)` totals for Prometheus export.
    pub fn snapshot(&self) -> (u64, u64) {
        (
            self.colocated.load(Ordering::Relaxed),
            self.split.load(Ordering::Relaxed),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_metrics_tally_colocated_and_split() {
        let m = MatchPairingMetrics::default();
        m.observe(true);
        m.observe(true);
        m.observe(false);
        assert_eq!(m.snapshot(), (2, 1));
    }

    #[test]
    fn drain_returns_only_new_deltas_per_game() {
        let c = LocalActionCounter::default();
        c.incr("ttt", 3);
        c.incr("blackjack", 1);
        let mut first = c.drain_deltas();
        first.sort();
        assert_eq!(
            first,
            vec![("blackjack".to_string(), 1), ("ttt".to_string(), 3)]
        );
        // nothing new → empty drain
        assert!(c.drain_deltas().is_empty());
        // further increments only report the new delta
        c.incr("ttt", 2);
        assert_eq!(c.drain_deltas(), vec![("ttt".to_string(), 2)]);
    }
}
