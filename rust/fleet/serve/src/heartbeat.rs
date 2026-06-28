//! Telemetry consumer: turns driver `MoveCommitted` events into coarse activity
//! heartbeats and posts them to `tunnel-manager`. Mirrors the frontend control
//! plane — the server owns the TPS math; we only report raw deltas, seat-A only,
//! roughly once a `flush_interval_ms` window, plus a trailing flush on finish.

use serde::Serialize;
use tunnel_harness::{MoveCommitted, Seat};

/// Wire-compatible with the server's `HeartbeatRequest` (camelCase; `nonce` is
/// a decimal string, matching the frontend's `BigInt.toString()`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPayload {
    pub tunnel_id: String,
    pub nonce: String,
    pub actions_delta: u64,
    pub window_ms: u64,
}

pub struct HeartbeatReporter {
    http: reqwest::Client,
    base_url: String,
    session_id: String,
    stats_token: String,
    reporting_seat: Seat,
    flush_interval_ms: u64,
    // per-run state:
    tunnel_id: String,
    our_seat: Seat,
    actions: u64,
    last_flush_ms: Option<u64>,
    last_ts_ms: u64,
    last_nonce: u64,
}

impl HeartbeatReporter {
    pub fn new(
        http: reqwest::Client,
        base_url: String,
        session_id: String,
        stats_token: String,
    ) -> Self {
        Self {
            http,
            base_url,
            session_id,
            stats_token,
            reporting_seat: Seat::A,
            flush_interval_ms: 1000,
            tunnel_id: String::new(),
            our_seat: Seat::A,
            actions: 0,
            last_flush_ms: None,
            last_ts_ms: 0,
            last_nonce: 0,
        }
    }

    pub fn with_cadence(mut self, reporting_seat: Seat, flush_interval_ms: u64) -> Self {
        self.reporting_seat = reporting_seat;
        self.flush_interval_ms = flush_interval_ms;
        self
    }

    /// Seed per-run context and reset accumulation.
    pub(crate) fn start(&mut self, tunnel_id: &str, our_seat: Seat) {
        self.tunnel_id = tunnel_id.to_string();
        self.our_seat = our_seat;
        self.actions = 0;
        self.last_flush_ms = None;
        self.last_ts_ms = 0;
        self.last_nonce = 0;
    }

    /// Account one committed move; return a payload when the window elapses.
    pub(crate) fn record(&mut self, ev: &MoveCommitted) -> Option<HeartbeatPayload> {
        if self.our_seat != self.reporting_seat {
            return None;
        }
        self.actions += 1;
        self.last_ts_ms = ev.timestamp_ms;
        self.last_nonce = ev.nonce;
        let base = *self.last_flush_ms.get_or_insert(ev.timestamp_ms);
        let window = ev.timestamp_ms.saturating_sub(base);
        if window >= self.flush_interval_ms {
            let payload = HeartbeatPayload {
                tunnel_id: self.tunnel_id.clone(),
                nonce: ev.nonce.to_string(),
                actions_delta: self.actions,
                window_ms: window,
            };
            self.actions = 0;
            self.last_flush_ms = Some(ev.timestamp_ms);
            Some(payload)
        } else {
            None
        }
    }

    /// Force-flush a trailing partial window (called on finish/abort).
    pub(crate) fn drain(&mut self) -> Option<HeartbeatPayload> {
        if self.actions == 0 {
            return None;
        }
        let base = self.last_flush_ms.unwrap_or(self.last_ts_ms);
        let window = self.last_ts_ms.saturating_sub(base);
        let payload = HeartbeatPayload {
            tunnel_id: self.tunnel_id.clone(),
            nonce: self.last_nonce.to_string(),
            actions_delta: self.actions,
            window_ms: window,
        };
        self.actions = 0;
        self.last_flush_ms = Some(self.last_ts_ms);
        Some(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_harness::{MoveCommitted, Seat};

    fn reporter(seat: Seat) -> HeartbeatReporter {
        let mut r = HeartbeatReporter::new(
            reqwest::Client::new(),
            "http://x".into(),
            "sess".into(),
            "tok".into(),
        )
        .with_cadence(Seat::A, 1000);
        r.start("0xabc", seat);
        r
    }

    fn ev(nonce: u64, idx: u64, ts: u64) -> MoveCommitted {
        MoveCommitted {
            by: Seat::A,
            nonce,
            move_index: idx,
            timestamp_ms: ts,
        }
    }

    #[test]
    fn non_reporting_seat_emits_nothing() {
        let mut r = reporter(Seat::B);
        assert_eq!(r.record(&ev(1, 1, 0)), None);
        assert_eq!(r.record(&ev(2, 2, 5000)), None);
        assert_eq!(r.drain(), None);
    }

    #[test]
    fn flushes_when_window_elapses_and_sums_actions() {
        let mut r = reporter(Seat::A);
        assert_eq!(r.record(&ev(1, 1, 0)), None); // seeds window base = 0, actions = 1
        assert_eq!(r.record(&ev(2, 2, 500)), None); // actions = 2, window 500 < 1000
        let p = r.record(&ev(3, 3, 1000)).expect("flush at 1000ms");
        assert_eq!(p.tunnel_id, "0xabc");
        assert_eq!(p.nonce, "3");
        assert_eq!(p.actions_delta, 3);
        assert_eq!(p.window_ms, 1000);
        // counter reset after flush.
        assert_eq!(r.drain(), None);
    }

    #[test]
    fn drain_force_flushes_trailing_window() {
        let mut r = reporter(Seat::A);
        assert_eq!(r.record(&ev(7, 1, 0)), None);
        assert_eq!(r.record(&ev(8, 2, 300)), None);
        let p = r.drain().expect("trailing flush");
        assert_eq!(p.actions_delta, 2);
        assert_eq!(p.nonce, "8");
        assert_eq!(p.window_ms, 300);
        assert_eq!(r.drain(), None); // nothing left
    }
}
