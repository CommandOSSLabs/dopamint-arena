//! Phase-aware live-telemetry client for a swarm.
//!
//! Ported from `fleet-bench`'s heartbeat observer and `fleet-serve`'s payload,
//! then extended with the run `phase` (open/play/settle) and its progress so a
//! supervising daemon's sink can render staged advancement, not just a raw TPS.
//!
//! Telemetry must never perturb the run it measures: posts are fire-and-forget,
//! share one keep-alive client, carry hard timeouts, and are capped in flight so
//! a slow/hung sink can't backpressure or exhaust the swarm's sockets and memory.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tunnel_harness::{DriverObserver, DriverOutcome, DriverStart, MoveCommitted};

/// Total budget for a single heartbeat POST; a hung sink must not pin a task.
const HEARTBEAT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Connect-phase budget, tighter than the overall request timeout.
const HEARTBEAT_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// Cap on concurrent in-flight posts. Sized well above what a healthy fast sink
/// needs so normal runs never drop; it only bounds pathological (slow/hung)
/// sinks to avoid unbounded task/socket growth.
const HEARTBEAT_MAX_INFLIGHT: usize = 256;

/// Phase name reported before the pipeline announces its first real phase.
const PHASE_INIT: &str = "init";

/// Wire-compatible with the server's heartbeat request (camelCase; `nonce` is a
/// decimal string matching the frontend's `BigInt.toString()`). Extends the
/// bench/serve payload with the run `phase` and its progress so the daemon sink
/// can render open/play/settle advancement. `phase` is a `String` (not a
/// `&'static str`) so the sink can deserialize the same type it receives.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPayload {
    pub tunnel_id: String,
    pub nonce: String,
    pub actions_delta: u64,
    pub window_ms: u64,
    pub phase: String,
    pub phase_done: u64,
    pub phase_total: u64,
}

/// Base URL + cadence for a swarm's telemetry, resolved to a [`HeartbeatConfig`]
/// once the sink registers a session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeartbeatSetup {
    pub base_url: String,
    pub flush_interval_ms: u64,
}

impl HeartbeatSetup {
    /// Register a session with the sink and return the per-run config. `game`
    /// carries the protocol id; the daemon folds the run identity into the sink
    /// URL so a session maps back to its run.
    pub async fn register(&self, protocol_id: &str) -> Result<HeartbeatConfig, String> {
        let response = reqwest::Client::new()
            .post(format!("{}/v1/sessions", self.base_url))
            .json(&RegisterSessionRequest {
                user_address: "fleet-superx",
                game: protocol_id,
                tunnels: Vec::new(),
            })
            .send()
            .await
            .map_err(|error| format!("heartbeat session registration failed: {error}"))?
            .error_for_status()
            .map_err(|error| format!("heartbeat session registration failed: {error}"))?
            .json::<RegisterSessionResponse>()
            .await
            .map_err(|error| format!("heartbeat session registration response: {error}"))?;

        Ok(HeartbeatConfig::new(
            self.base_url.clone(),
            response.session_id,
            response.stats_token,
            self.flush_interval_ms,
        ))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterSessionRequest<'a> {
    user_address: &'static str,
    game: &'a str,
    tunnels: Vec<TunnelRef>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TunnelRef {
    tunnel_id: String,
    party_a: String,
    party_b: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterSessionResponse {
    session_id: String,
    stats_token: String,
}

/// The current run phase and its progress, stamped onto every payload so the sink
/// can render which stage each swarm is in. Shared across a run's per-tunnel
/// reporters; the pipeline advances it at each phase transition.
#[derive(Clone, Debug)]
struct PhaseSnapshot {
    phase: &'static str,
    done: u64,
    total: u64,
}

impl PhaseSnapshot {
    fn init() -> Self {
        Self {
            phase: PHASE_INIT,
            done: 0,
            total: 0,
        }
    }
}

/// Per-run heartbeat configuration. Holds the shared client, in-flight budget,
/// and phase snapshot so every per-tunnel reporter is a cheap refcount clone
/// rather than a fresh client (which would kill connection reuse) or an unbounded
/// spawner, and so a phase advance is observed by all tunnels at once.
#[derive(Clone, Debug)]
pub struct HeartbeatConfig {
    pub base_url: Arc<str>,
    pub session_id: Arc<str>,
    pub stats_token: Arc<str>,
    pub flush_interval_ms: u64,
    /// Shared across all per-tunnel observers so the cadence and phase are per
    /// run, not multiplied by tunnel concurrency.
    sink: Arc<SwarmHeartbeatSink>,
}

impl HeartbeatConfig {
    pub(crate) fn new(
        base_url: String,
        session_id: String,
        stats_token: String,
        flush_interval_ms: u64,
    ) -> Self {
        let http = build_client();
        let heartbeat_url: Arc<str> =
            format!("{base_url}/v1/sessions/{session_id}/heartbeat").into();
        let stats_token: Arc<str> = stats_token.into();
        let inflight = Arc::new(Semaphore::new(HEARTBEAT_MAX_INFLIGHT));
        let sink = Arc::new(SwarmHeartbeatSink::new(
            http,
            Arc::clone(&stats_token),
            Arc::clone(&heartbeat_url),
            Arc::clone(&inflight),
            Duration::from_millis(flush_interval_ms.max(1)),
        ));
        Self {
            base_url: base_url.into(),
            session_id: session_id.into(),
            stats_token,
            flush_interval_ms,
            sink,
        }
    }

    /// A per-tunnel observer sharing this run's cadence, in-flight budget, and
    /// phase. Attach one to a single seat per tunnel.
    pub fn reporter(&self) -> SwarmHeartbeatReporter {
        SwarmHeartbeatReporter::new(Arc::clone(&self.sink))
    }

    /// Advance the reported run phase (open/play/settle). Observed by every
    /// reporter's next flush, so the sink sees the transition run-wide at once.
    pub fn set_phase(&self, phase: &'static str) {
        self.sink.set_phase(phase);
    }

    /// Update progress counters (`done`/`total`) stamped onto subsequent payloads
    /// within the current phase.
    pub fn set_phase_progress(&self, done: u64, total: u64) {
        self.sink.set_phase_progress(done, total);
    }
}

/// Build the shared client with hard timeouts so a stalled sink releases the task
/// and socket instead of pinning them for the whole run.
fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(HEARTBEAT_REQUEST_TIMEOUT)
        .connect_timeout(HEARTBEAT_CONNECT_TIMEOUT)
        .build()
        .expect("heartbeat reqwest client builds with static timeouts")
}

#[derive(Debug)]
struct SwarmHeartbeatSink {
    http: reqwest::Client,
    stats_token: Arc<str>,
    heartbeat_url: Arc<str>,
    inflight: Arc<Semaphore>,
    flush_interval: Duration,
    state: Mutex<SwarmHeartbeatState>,
    phase: Mutex<PhaseSnapshot>,
}

#[derive(Debug)]
struct SwarmHeartbeatState {
    tunnel_id: String,
    actions: u64,
    window_started: Instant,
    last_nonce: u64,
    flush_scheduled: bool,
}

impl SwarmHeartbeatState {
    fn new(now: Instant) -> Self {
        Self {
            tunnel_id: String::new(),
            actions: 0,
            window_started: now,
            last_nonce: 0,
            flush_scheduled: false,
        }
    }

    fn payload(
        &mut self,
        now: Instant,
        window: Duration,
        phase: &PhaseSnapshot,
    ) -> Option<HeartbeatPayload> {
        if self.actions == 0 {
            self.window_started = now;
            self.flush_scheduled = false;
            return None;
        }
        let payload = HeartbeatPayload {
            tunnel_id: self.tunnel_id.clone(),
            nonce: self.last_nonce.to_string(),
            actions_delta: self.actions,
            window_ms: (window.as_millis() as u64).max(1),
            phase: phase.phase.to_string(),
            phase_done: phase.done,
            phase_total: phase.total,
        };
        self.actions = 0;
        self.window_started = now;
        self.flush_scheduled = false;
        Some(payload)
    }
}

impl SwarmHeartbeatSink {
    fn new(
        http: reqwest::Client,
        stats_token: Arc<str>,
        heartbeat_url: Arc<str>,
        inflight: Arc<Semaphore>,
        flush_interval: Duration,
    ) -> Self {
        Self {
            http,
            stats_token,
            heartbeat_url,
            inflight,
            flush_interval,
            state: Mutex::new(SwarmHeartbeatState::new(Instant::now())),
            phase: Mutex::new(PhaseSnapshot::init()),
        }
    }

    fn set_phase(&self, phase: &'static str) {
        self.phase.lock().expect("heartbeat phase lock").phase = phase;
    }

    fn set_phase_progress(&self, done: u64, total: u64) {
        let mut phase = self.phase.lock().expect("heartbeat phase lock");
        phase.done = done;
        phase.total = total;
    }

    fn phase(&self) -> PhaseSnapshot {
        self.phase.lock().expect("heartbeat phase lock").clone()
    }

    fn record(&self, tunnel_id: &str, nonce: u64) -> Option<HeartbeatPayload> {
        let now = Instant::now();
        let phase = self.phase();
        let mut state = self.state.lock().expect("heartbeat state lock");
        if state.actions == 0 {
            state.window_started = now;
        }
        state.actions += 1;
        state.tunnel_id = tunnel_id.to_string();
        state.last_nonce = nonce;
        let window = now.saturating_duration_since(state.window_started);
        if window >= self.flush_interval {
            state.payload(now, window, &phase)
        } else {
            None
        }
    }

    fn flush_if_due(&self) -> Option<HeartbeatPayload> {
        let now = Instant::now();
        let phase = self.phase();
        let mut state = self.state.lock().expect("heartbeat state lock");
        let window = now.saturating_duration_since(state.window_started);
        if window >= self.flush_interval {
            state.payload(now, window, &phase)
        } else {
            None
        }
    }

    fn schedule_flush(self: &Arc<Self>) {
        let delay = {
            let now = Instant::now();
            let mut state = self.state.lock().expect("heartbeat state lock");
            if state.actions == 0 || state.flush_scheduled {
                return;
            }
            state.flush_scheduled = true;
            let elapsed = now.saturating_duration_since(state.window_started);
            self.flush_interval.saturating_sub(elapsed)
        };
        self.spawn_flush_after(delay);
    }

    fn spawn_flush_after(self: &Arc<Self>, delay: Duration) {
        let sink = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            sink.flush_due_or_reschedule();
        });
    }

    fn flush_due_or_reschedule(self: Arc<Self>) {
        let now = Instant::now();
        let phase = self.phase();
        let mut retry_after = None;
        let payload = {
            let mut state = self.state.lock().expect("heartbeat state lock");
            state.flush_scheduled = false;
            if state.actions == 0 {
                None
            } else {
                let window = now.saturating_duration_since(state.window_started);
                if window >= self.flush_interval {
                    state.payload(now, window, &phase)
                } else {
                    state.flush_scheduled = true;
                    retry_after = Some(self.flush_interval.saturating_sub(window));
                    None
                }
            }
        };
        if let Some(payload) = payload {
            self.dispatch(payload);
        } else if let Some(delay) = retry_after {
            self.spawn_flush_after(delay);
        }
    }

    fn dispatch(&self, payload: HeartbeatPayload) {
        // Reserve an in-flight slot before spawning. If the cap is saturated
        // (only a slow/hung sink gets here), drop the sample: telemetry must
        // never block or await on the driver's hot path.
        let Ok(permit) = Arc::clone(&self.inflight).try_acquire_owned() else {
            tracing::debug!("fleet-superx heartbeat dropped: in-flight cap reached");
            return;
        };
        let http = self.http.clone();
        let url = Arc::clone(&self.heartbeat_url);
        let stats_token = Arc::clone(&self.stats_token);
        tokio::spawn(async move {
            // Held for the request's lifetime, releasing the slot on completion.
            let _permit = permit;
            let result = http
                .post(url.as_ref())
                .bearer_auth(stats_token.as_ref())
                .json(&payload)
                .send()
                .await
                .and_then(reqwest::Response::error_for_status);
            if let Err(error) = result {
                tracing::warn!(%error, "fleet-superx heartbeat post failed");
            }
        });
    }
}

/// A per-tunnel [`DriverObserver`] that windows committed moves into heartbeats
/// and posts them fire-and-forget. Attach to exactly one seat per tunnel.
pub struct SwarmHeartbeatReporter {
    sink: Arc<SwarmHeartbeatSink>,
    tunnel_id: String,
}

impl SwarmHeartbeatReporter {
    fn new(sink: Arc<SwarmHeartbeatSink>) -> Self {
        Self {
            sink,
            tunnel_id: String::new(),
        }
    }

    fn start(&mut self, tunnel_id: &str) {
        self.tunnel_id = tunnel_id.to_string();
    }

    fn record(&mut self, ev: &MoveCommitted) -> Option<HeartbeatPayload> {
        self.sink.record(&self.tunnel_id, ev.nonce)
    }

    fn drain(&mut self) -> Option<HeartbeatPayload> {
        self.sink.flush_if_due()
    }

    fn dispatch(&self, payload: HeartbeatPayload) {
        self.sink.dispatch(payload);
    }
}

impl DriverObserver for SwarmHeartbeatReporter {
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
        } else {
            self.sink.schedule_flush();
        }
    }

    fn on_aborted(&mut self) {
        if let Some(payload) = self.drain() {
            self.dispatch(payload);
        } else {
            self.sink.schedule_flush();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_harness::Seat;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn committed(nonce: u64) -> MoveCommitted {
        MoveCommitted {
            by: Seat::A,
            nonce,
            move_index: nonce,
            timestamp_ms: nonce,
        }
    }

    #[test]
    fn payload_serializes_camelcase_with_phase() {
        let payload = HeartbeatPayload {
            tunnel_id: "0xabc".into(),
            nonce: "9".into(),
            actions_delta: 4,
            window_ms: 1000,
            phase: "play".into(),
            phase_done: 2,
            phase_total: 6,
        };
        let body = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(body["tunnelId"], "0xabc");
        assert_eq!(body["nonce"], "9");
        assert_eq!(body["actionsDelta"], 4);
        assert_eq!(body["windowMs"], 1000);
        assert_eq!(body["phase"], "play");
        assert_eq!(body["phaseDone"], 2);
        assert_eq!(body["phaseTotal"], 6);
    }

    #[tokio::test]
    async fn setup_registers_session_and_precomputes_heartbeat_url() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/sessions"))
            .and(body_json(serde_json::json!({
                "userAddress": "fleet-superx",
                "game": "blackjack.v2",
                "tunnels": []
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sessionId": "sess-1",
                "statsToken": "tok-1"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let setup = HeartbeatSetup {
            base_url: server.uri(),
            flush_interval_ms: 250,
        };
        let config = setup.register("blackjack.v2").await.expect("register");

        assert_eq!(&*config.base_url, server.uri());
        assert_eq!(&*config.session_id, "sess-1");
        assert_eq!(&*config.stats_token, "tok-1");
        assert_eq!(config.flush_interval_ms, 250);
        // URL is precomputed once so dispatch never re-formats per flush.
        assert_eq!(
            &*config.sink.heartbeat_url,
            format!("{}/v1/sessions/sess-1/heartbeat", server.uri())
        );
    }

    #[tokio::test]
    async fn set_phase_is_stamped_onto_the_next_flush() {
        let config = HeartbeatConfig::new("http://x".into(), "sess".into(), "tok".into(), 1);
        config.set_phase_progress(3, 6);
        let mut reporter = config.reporter();
        reporter.start("0xabc");

        // Accumulate one action, advance the phase, then let the window elapse so
        // the trailing flush carries the phase set after the move was recorded.
        assert_eq!(reporter.record(&committed(1)), None);
        config.set_phase("play");
        tokio::time::sleep(Duration::from_millis(5)).await;

        let payload = reporter.drain().expect("trailing flush after window elapses");
        assert_eq!(payload.phase, "play");
        assert_eq!(payload.phase_done, 3);
        assert_eq!(payload.phase_total, 6);
        assert_eq!(payload.actions_delta, 1);
    }
}
