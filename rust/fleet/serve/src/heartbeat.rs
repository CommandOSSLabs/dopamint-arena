//! Telemetry consumer: turns driver `MoveCommitted` events into coarse activity
//! heartbeats and posts them to `tunnel-manager`. Mirrors the frontend control
//! plane — the server owns the TPS math; we only report raw deltas, session-owner
//! only, roughly once a `flush_interval_ms` window, plus a trailing flush on finish.

use serde::Serialize;
use tunnel_harness::{DriverObserver, DriverOutcome, DriverStart, MoveCommitted};

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

/// Posts activity heartbeats for one served tunnel. Holding a `stats_token` is
/// what makes a party the session's reporter (the server mints exactly one token
/// per registration), so the at-most-once guarantee is structural: a reporter is
/// only ever constructed and attached for a tunnel this party registered. There
/// is deliberately no internal seat/ownership flag — possessing the token and
/// attaching the reporter *is* the gate.
pub struct HeartbeatReporter {
    http: reqwest::Client,
    base_url: String,
    session_id: String,
    stats_token: String,
    flush_interval_ms: u64,
    // per-run state:
    tunnel_id: String,
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
            flush_interval_ms: 1000,
            tunnel_id: String::new(),
            actions: 0,
            last_flush_ms: None,
            last_ts_ms: 0,
            last_nonce: 0,
        }
    }

    /// Override the flush window (default 1000ms).
    pub fn with_cadence(mut self, flush_interval_ms: u64) -> Self {
        self.flush_interval_ms = flush_interval_ms;
        self
    }

    /// Seed per-run context and reset accumulation.
    pub(crate) fn start(&mut self, tunnel_id: &str) {
        self.tunnel_id = tunnel_id.to_string();
        self.actions = 0;
        self.last_flush_ms = None;
        self.last_ts_ms = 0;
        self.last_nonce = 0;
    }

    /// Account one committed move; return a payload when the window elapses.
    pub(crate) fn record(&mut self, ev: &MoveCommitted) -> Option<HeartbeatPayload> {
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
            window_ms: window.max(1),
        };
        self.actions = 0;
        self.last_flush_ms = Some(self.last_ts_ms);
        Some(payload)
    }
}

async fn post_heartbeat(
    http: reqwest::Client,
    base_url: String,
    session_id: String,
    stats_token: String,
    payload: HeartbeatPayload,
) -> Result<(), reqwest::Error> {
    let url = format!("{base_url}/v1/sessions/{session_id}/heartbeat");
    http.post(url)
        .bearer_auth(stats_token)
        .json(&payload)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

impl HeartbeatReporter {
    /// Fire-and-forget: never block the move loop on network IO. A dropped
    /// heartbeat is a lost stat, never a stalled game.
    fn dispatch(&self, payload: HeartbeatPayload) {
        let http = self.http.clone();
        let base_url = self.base_url.clone();
        let session_id = self.session_id.clone();
        let stats_token = self.stats_token.clone();
        tokio::spawn(async move {
            if let Err(e) = post_heartbeat(http, base_url, session_id, stats_token, payload).await {
                tracing::warn!(error = %e, "heartbeat post failed");
            }
        });
    }
}

impl DriverObserver for HeartbeatReporter {
    fn on_started(&mut self, start: &DriverStart<'_>) {
        self.start(start.tunnel_id);
    }
    fn on_move_committed(&mut self, ev: &MoveCommitted) {
        if let Some(payload) = self.record(ev) {
            self.dispatch(payload);
        }
    }
    fn on_finished(&mut self, _outcome: &DriverOutcome) {
        if let Some(payload) = self.drain() {
            self.dispatch(payload);
        }
    }
    fn on_aborted(&mut self) {
        if let Some(payload) = self.drain() {
            self.dispatch(payload);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_harness::{MoveCommitted, Seat};

    fn reporter() -> HeartbeatReporter {
        let mut r = HeartbeatReporter::new(
            reqwest::Client::new(),
            "http://x".into(),
            "sess".into(),
            "tok".into(),
        )
        .with_cadence(1000);
        r.start("0xabc");
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
    fn flushes_when_window_elapses_and_sums_actions() {
        let mut r = reporter();
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
        let mut r = reporter();
        assert_eq!(r.record(&ev(7, 1, 0)), None);
        assert_eq!(r.record(&ev(8, 2, 300)), None);
        let p = r.drain().expect("trailing flush");
        assert_eq!(p.actions_delta, 2);
        assert_eq!(p.nonce, "8");
        assert_eq!(p.window_ms, 300);
        assert_eq!(r.drain(), None); // nothing left
    }

    #[test]
    fn drain_clamps_single_action_window_to_one_ms() {
        // Single move at ts=0: base = 0, last_ts = 0, window = 0 → must clamp to 1.
        let mut r = reporter();
        assert_eq!(r.record(&ev(1, 1, 0)), None);
        let p = r.drain().expect("trailing flush");
        assert_eq!(p.actions_delta, 1);
        assert_eq!(p.window_ms, 1);
        assert_eq!(r.drain(), None);
    }

    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn post_heartbeat_sends_camelcase_json_with_bearer() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/sessions/sess-1/heartbeat"))
            .and(header("authorization", "Bearer tok-1"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        let payload = HeartbeatPayload {
            tunnel_id: "0xabc".into(),
            nonce: "9".into(),
            actions_delta: 4,
            window_ms: 1000,
        };
        post_heartbeat(
            reqwest::Client::new(),
            server.uri(),
            "sess-1".into(),
            "tok-1".into(),
            payload,
        )
        .await
        .expect("post ok");

        let reqs = server.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1);
        let body: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
        assert_eq!(body["tunnelId"], "0xabc");
        assert_eq!(body["nonce"], "9");
        assert_eq!(body["actionsDelta"], 4);
        assert_eq!(body["windowMs"], 1000);
    }
}
