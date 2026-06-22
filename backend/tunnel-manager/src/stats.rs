//! The stats broadcaster: compute the aggregate snapshot ONCE per tick and fan it
//! out to every SSE subscriber, so cost scales with the audience, not with TPS.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::state::SharedState;

/// How often a fresh snapshot is pushed to SSE subscribers. Kept short for a "live" feel.
const TICK: Duration = Duration::from_millis(500);

/// Trailing window the throughput rate is averaged over. DECOUPLED from `TICK` on purpose:
/// we still push twice a second, we just *measure* over a longer baseline. A single sporadic
/// player reports its moves in batches ~1–2 s apart, so a per-tick delta aliases to a spike
/// one tick and zero the next; integrating over several inter-arrival gaps yields a steady
/// figure. The same derivative stays exact up into the millions/sec the bot fleet produces.
/// Tradeoff: the displayed rate ramps over ~this window on a large step change — desirable
/// smoothing for the dashboard; lower it if a snappier reading is wanted.
const RATE_WINDOW: Duration = Duration::from_secs(5);

/// Smoothed actions/sec over a trailing window, derived from a monotonic counter — the same
/// counter-derivative model as Prometheus `rate()`. Holds just the samples inside the window.
struct RateWindow {
    window: Duration,
    samples: std::collections::VecDeque<(Instant, u64)>,
}

impl RateWindow {
    fn new(window: Duration) -> Self {
        Self {
            window,
            samples: std::collections::VecDeque::new(),
        }
    }

    /// Record the counter reading at `now` and return actions/sec over the trailing window.
    /// Warm-up (< `window` of history) measures over whatever span is available, so the rate
    /// is sane from the first second. A counter that goes backwards (Redis flush / instance
    /// restart) clamps that interval to 0 instead of emitting a negative spike.
    fn observe(&mut self, now: Instant, total: u64) -> f64 {
        self.samples.push_back((now, total));
        // Drop samples that have aged out of the window, always keeping ≥1 as the anchor.
        while self.samples.len() > 1 {
            let (t, _) = self.samples[0];
            if now.duration_since(t) > self.window {
                self.samples.pop_front();
            } else {
                break;
            }
        }
        let (t0, c0) = self.samples[0];
        let (t1, c1) = self.samples[self.samples.len() - 1];
        let dt = t1.duration_since(t0).as_secs_f64();
        if dt <= 0.0 {
            return 0.0;
        }
        // Subtract as u64 BEFORE the f64 cast: only the small per-window delta (~millions at
        // most) touches f64, so it stays exact even after the absolute total passes 2^53.
        c1.saturating_sub(c0) as f64 / dt
    }
}

/// Recompute the aggregate snapshot once per tick and broadcast it to every SSE subscriber.
/// `tps` is a sliding-window rate (see `RateWindow`), not a lifetime average and not a raw
/// per-tick delta.
pub(crate) fn spawn_stats_broadcaster(state: SharedState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(TICK);
        let mut global = RateWindow::new(RATE_WINDOW);
        let mut per_game: HashMap<String, RateWindow> = HashMap::new();
        loop {
            interval.tick().await;
            let now = Instant::now();
            let mut snap = state.control.snapshot().await;
            snap.tps = global.observe(now, snap.total_actions);
            for (game, stat) in snap.per_game.iter_mut() {
                let w = per_game
                    .entry(game.clone())
                    .or_insert_with(|| RateWindow::new(RATE_WINDOW));
                stat.tps = w.observe(now, stat.total_actions);
            }
            if let Ok(json) = serde_json::to_string(&snap) {
                let _ = state.stats_tx.send(json);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    // Regression lock for the "displays 4, then 0" bug. A single player reports ~2 actions
    // every ~1.8 s; the old `delta * (1000/TICK_MS)` read the counter every 500 ms, so the
    // tick that caught a batch showed 2*2=4 and the rest showed 0. The windowed rate must
    // instead read a steady ~1.1/s: bounded, never spiking to 4, never collapsing to 0.
    #[test]
    fn bursty_single_player_rate_is_steady_not_aliased() {
        let mut w = RateWindow::new(Duration::from_secs(5));
        let start = Instant::now();
        let mut total = 0u64;
        let mut next_batch_ms = 1800u64;
        let mut readings = Vec::new();
        // 12 s of 500 ms ticks; counter jumps +2 every 1.8 s (the heartbeat cadence).
        for tick in 0..=24u64 {
            let ms = tick * 500;
            while ms >= next_batch_ms {
                total += 2;
                next_batch_ms += 1800;
            }
            let r = w.observe(at(start, ms), total);
            if ms >= 6000 {
                readings.push(r); // sample only once the 5 s window is full
            }
        }
        let max = readings.iter().cloned().fold(f64::MIN, f64::max);
        let min = readings.iter().cloned().fold(f64::MAX, f64::min);
        let mean = readings.iter().sum::<f64>() / readings.len() as f64;
        assert!(max < 2.5, "rate spiked to {max}, the old aliasing bug");
        assert!(min > 0.3, "rate collapsed to {min}, the old aliasing bug");
        assert!(
            (mean - 1.11).abs() < 0.4,
            "mean {mean} should track the true ~1.11/s rate"
        );
    }

    // The headline case: a continuous high rate must read back accurately. 500k actions per
    // 500 ms tick == 1e6/s, sustained — the figure the fleet demo is built to show.
    #[test]
    fn sustained_million_tps_reads_back_accurately() {
        let mut w = RateWindow::new(Duration::from_secs(5));
        let start = Instant::now();
        let mut total = 0u64;
        let mut last = 0.0;
        for tick in 0..=40u64 {
            total += 500_000; // per 500 ms tick
            last = w.observe(at(start, tick * 500), total);
        }
        assert!(
            (last - 1_000_000.0).abs() < 1_000.0,
            "expected ~1e6 TPS, got {last}"
        );
    }

    // A counter that resets (Redis flush / restart) must not emit a negative or absurd spike.
    #[test]
    fn counter_reset_does_not_emit_negative_rate() {
        let mut w = RateWindow::new(Duration::from_secs(5));
        let start = Instant::now();
        w.observe(at(start, 0), 1_000_000);
        w.observe(at(start, 500), 1_000_500);
        let r = w.observe(at(start, 1000), 0); // counter reset
        assert!(r >= 0.0, "reset produced a negative rate: {r}");
    }

    // First reading has no prior sample to diff against → 0, never a divide-by-zero.
    #[test]
    fn first_observation_is_zero() {
        let mut w = RateWindow::new(Duration::from_secs(5));
        assert_eq!(w.observe(Instant::now(), 42), 0.0);
    }
}
