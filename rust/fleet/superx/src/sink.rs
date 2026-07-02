//! Localhost heartbeat sink + live per-run aggregate.
//!
//! Swarm subprocesses post phase-aware heartbeats (see [`crate::swarm::heartbeat`])
//! to this sink over loopback. The daemon roots each swarm's telemetry at
//! `http://<sink-addr>/runs/<run_id>`, so the run id rides in the URL path of both
//! the session registration and every heartbeat; the sink folds each heartbeat
//! into that run's [`LiveAggregate`] for `watch` (Phase C3) to stream.
//!
//! The sink is intentionally trust-nothing about ordering or completeness: it
//! sums move deltas and stamps the latest phase, so a dropped or late heartbeat
//! only loses that window rather than corrupting the running total.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;

use crate::swarm::heartbeat::HeartbeatPayload;

/// Live, best-effort view of one run's progress, folded from its swarms'
/// heartbeats. Authoritative totals come from the merged [`SwarmReport`] on
/// completion; this is the in-flight signal `watch` renders while the run is
/// still executing.
///
/// [`SwarmReport`]: crate::swarm::report::SwarmReport
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAggregate {
    /// Latest phase reported by any swarm (`init`/`open`/`play`/`settle`).
    pub phase: String,
    /// Progress within the latest phase, as last reported (`done`/`total`).
    pub phase_done: u64,
    pub phase_total: u64,
    /// Heartbeats folded per phase name — a coarse fan-out indicator for `watch`.
    pub phase_counts: HashMap<String, u64>,
    /// Total committed moves summed across every heartbeat for this run.
    pub moves: u64,
    /// Best-effort settled-tunnel count, taken from the high-water `phase_done`
    /// observed while the run reports the `settle` phase.
    pub tunnels_settled: u64,
    /// Unix-epoch milliseconds of the last fold, so `watch` can show staleness.
    pub updated_ms: u64,
}

/// Localhost heartbeat sink: a shared map of run id to its [`LiveAggregate`],
/// folded by the HTTP handlers. Cloning shares the same state (an `Arc`), so the
/// daemon can hand one clone to [`serve_sink`] and keep another for `watch`.
#[derive(Clone)]
pub struct Sink {
    live: Arc<Mutex<HashMap<String, LiveAggregate>>>,
    session_seq: Arc<AtomicU64>,
}

impl Sink {
    pub fn new() -> Self {
        Self {
            live: Arc::new(Mutex::new(HashMap::new())),
            session_seq: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Ensure a run has an aggregate entry, so `watch` shows a run the instant its
    /// first swarm registers a session — before any move has been committed.
    fn ensure_run(&self, run_id: &str) {
        self.live
            .lock()
            .expect("sink live lock")
            .entry(run_id.to_string())
            .or_default();
    }

    /// Fold one heartbeat into its run's aggregate: sum the move delta, stamp the
    /// latest phase + progress, and advance the settled high-water mark.
    fn record(&self, run_id: &str, payload: &HeartbeatPayload) {
        let mut live = self.live.lock().expect("sink live lock");
        let agg = live.entry(run_id.to_string()).or_default();
        agg.moves = agg.moves.saturating_add(payload.actions_delta);
        agg.phase = payload.phase.clone();
        agg.phase_done = payload.phase_done;
        agg.phase_total = payload.phase_total;
        *agg.phase_counts.entry(payload.phase.clone()).or_default() += 1;
        if payload.phase == "settle" {
            agg.tunnels_settled = agg.tunnels_settled.max(payload.phase_done);
        }
        agg.updated_ms = now_ms();
    }

    /// Snapshot a run's live aggregate, or `None` if no heartbeat/registration has
    /// been seen for it yet.
    pub fn snapshot(&self, run_id: &str) -> Option<LiveAggregate> {
        self.live
            .lock()
            .expect("sink live lock")
            .get(run_id)
            .cloned()
    }
}

impl Default for Sink {
    fn default() -> Self {
        Self::new()
    }
}

/// Serve the heartbeat sink on `listener` until it errors. Mirrors the control
/// listeners ([`crate::daemon::serve_unix`]): the caller binds (so a test can use
/// an ephemeral `127.0.0.1:0` port) and this drives the accept loop. Two routes,
/// both run-scoped by the leading `/runs/:run_id` segment the daemon roots each
/// swarm's telemetry at:
///  - `POST /runs/:run_id/v1/sessions` mints a session (matches the client's
///    registration contract) and creates the run's aggregate;
///  - `POST /runs/:run_id/v1/sessions/:session_id/heartbeat` folds one payload.
pub async fn serve_sink(listener: TcpListener, sink: Sink) -> std::io::Result<()> {
    let app = Router::new()
        .route("/runs/:run_id/v1/sessions", post(register_session))
        .route(
            "/runs/:run_id/v1/sessions/:session_id/heartbeat",
            post(fold_heartbeat),
        )
        .with_state(sink);
    axum::serve(listener, app).await
}

/// Register a run-scoped session. The run id comes from the path, so the response
/// only needs to mint identifiers the client will echo back on each heartbeat.
async fn register_session(
    Path(run_id): Path<String>,
    State(sink): State<Sink>,
) -> Json<RegisterSessionResponse> {
    sink.ensure_run(&run_id);
    let seq = sink.session_seq.fetch_add(1, Ordering::Relaxed);
    Json(RegisterSessionResponse {
        session_id: format!("{run_id}:{seq}"),
        stats_token: format!("fleet-superx-sink-{seq}"),
    })
}

/// Fold one heartbeat into its run's aggregate. The session id is carried for
/// wire compatibility with the client; folding keys on the path's run id.
async fn fold_heartbeat(
    Path((run_id, _session_id)): Path<(String, String)>,
    State(sink): State<Sink>,
    Json(payload): Json<HeartbeatPayload>,
) -> StatusCode {
    sink.record(&run_id, &payload);
    StatusCode::NO_CONTENT
}

/// Registration response, wire-compatible with the client's expectation
/// (`sessionId`/`statsToken`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterSessionResponse {
    session_id: String,
    stats_token: String,
}

/// Wall-clock milliseconds since the Unix epoch, saturating to 0 before it.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::swarm::heartbeat::HeartbeatPayload;

    fn heartbeat(actions: u64, phase: &str, done: u64) -> HeartbeatPayload {
        HeartbeatPayload {
            tunnel_id: "0xabc".into(),
            nonce: "1".into(),
            actions_delta: actions,
            window_ms: 1000,
            phase: phase.into(),
            phase_done: done,
            phase_total: 4,
        }
    }

    #[tokio::test]
    async fn folds_register_then_heartbeats_into_run_aggregate() {
        let sink = Sink::new();
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind sink");
        let addr = listener.local_addr().expect("sink addr");
        let server = tokio::spawn(serve_sink(listener, sink.clone()));

        // The daemon roots a swarm's telemetry at `/runs/<run_id>`, exactly as the
        // heartbeat client composes its session + heartbeat URLs.
        let base = format!("http://{addr}/runs/run-xyz");
        let http = reqwest::Client::new();

        let registration: serde_json::Value = http
            .post(format!("{base}/v1/sessions"))
            .json(&serde_json::json!({
                "userAddress": "fleet-superx",
                "game": "blackjack.v2",
                "tunnels": []
            }))
            .send()
            .await
            .expect("register send")
            .error_for_status()
            .expect("register status")
            .json()
            .await
            .expect("register json");
        let session_id = registration["sessionId"]
            .as_str()
            .expect("sessionId")
            .to_string();
        let stats_token = registration["statsToken"].as_str().expect("statsToken");

        // A run appears the moment it registers, before any move lands.
        assert_eq!(sink.snapshot("run-xyz").expect("run present").moves, 0);

        for payload in [heartbeat(3, "play", 1), heartbeat(5, "settle", 2)] {
            http.post(format!("{base}/v1/sessions/{session_id}/heartbeat"))
                .bearer_auth(stats_token)
                .json(&payload)
                .send()
                .await
                .expect("heartbeat send")
                .error_for_status()
                .expect("heartbeat status");
        }

        let snapshot = sink.snapshot("run-xyz").expect("run present after heartbeats");
        assert_eq!(snapshot.moves, 8, "move deltas fold additively");
        assert_eq!(snapshot.phase, "settle", "latest phase wins");
        assert_eq!(snapshot.phase_done, 2);
        assert_eq!(snapshot.tunnels_settled, 2, "settle phase_done high-water");
        assert_eq!(snapshot.phase_counts.get("play"), Some(&1));
        assert_eq!(snapshot.phase_counts.get("settle"), Some(&1));
        assert!(snapshot.updated_ms > 0);

        server.abort();
    }
}
