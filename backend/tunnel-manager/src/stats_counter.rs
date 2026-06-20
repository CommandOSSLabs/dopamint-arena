//! Per-instance, per-game move counter. The relay hot path increments these in-process
//! (no Redis); a 1/s flusher pushes the delta-since-last-flush into ControlStore so the
//! global counter stays correct without a per-move round trip. At-most-once on a crash
//! (lose ≤1 flush interval of display counts) — acceptable for display stats, never
//! inflates because we only ever push real, already-counted deltas.

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

#[cfg(test)]
mod tests {
    use super::*;

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
