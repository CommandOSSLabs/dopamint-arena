//! Fleet-bench heartbeat configuration and observer.
//!
//! The payload shape is shared with `fleet-serve`, but bench windows by wall
//! clock instead of the driver's synthetic deterministic timestamps.
//!
//! Telemetry must never perturb the benchmark it measures: posts are
//! fire-and-forget, share one keep-alive client, carry hard timeouts, and are
//! capped in flight so a slow/hung backend can't backpressure or exhaust the
//! process's sockets and memory.

use std::sync::Arc;
use std::time::{Duration, Instant};

use fleet_serve::HeartbeatPayload;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tunnel_harness::{DriverObserver, DriverOutcome, DriverStart, MoveCommitted};

/// Total budget for a single heartbeat POST; a hung backend must not pin a task.
const HEARTBEAT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Connect-phase budget, tighter than the overall request timeout.
const HEARTBEAT_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// Cap on concurrent in-flight posts. Sized well above what a healthy fast
/// backend needs so normal runs never drop; it only bounds pathological
/// (slow/hung) backends to avoid unbounded task/socket growth.
const HEARTBEAT_MAX_INFLIGHT: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeartbeatSetup {
    pub base_url: String,
    pub flush_interval_ms: u64,
}

impl HeartbeatSetup {
    pub async fn register(&self, protocol_id: &str) -> Result<HeartbeatConfig, String> {
        let response = reqwest::Client::new()
            .post(format!("{}/v1/sessions", self.base_url))
            .json(&RegisterSessionRequest {
                user_address: "fleet-bench",
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

/// Per-run heartbeat configuration. Holds the shared client and in-flight
/// budget so every per-tunnel reporter is a cheap refcount clone rather than a
/// fresh client (which would kill connection reuse) or an unbounded spawner.
#[derive(Clone, Debug)]
pub struct HeartbeatConfig {
    pub base_url: Arc<str>,
    pub session_id: Arc<str>,
    pub stats_token: Arc<str>,
    pub flush_interval_ms: u64,
    /// One keep-alive client per run; `reqwest::Client` is internally `Arc`.
    http: reqwest::Client,
    /// Precomputed once so dispatch never re-`format!`s the URL per flush.
    heartbeat_url: Arc<str>,
    /// Shared across all tunnels to bound total concurrent posts per run.
    inflight: Arc<Semaphore>,
}

impl HeartbeatConfig {
    pub(crate) fn new(
        base_url: String,
        session_id: String,
        stats_token: String,
        flush_interval_ms: u64,
    ) -> Self {
        let heartbeat_url: Arc<str> =
            format!("{base_url}/v1/sessions/{session_id}/heartbeat").into();
        Self {
            base_url: base_url.into(),
            session_id: session_id.into(),
            stats_token: stats_token.into(),
            flush_interval_ms,
            http: build_client(),
            heartbeat_url,
            inflight: Arc::new(Semaphore::new(HEARTBEAT_MAX_INFLIGHT)),
        }
    }

    pub(crate) fn reporter(&self) -> BenchHeartbeatReporter {
        BenchHeartbeatReporter::new(
            self.http.clone(),
            Arc::clone(&self.stats_token),
            Arc::clone(&self.heartbeat_url),
            Arc::clone(&self.inflight),
            Duration::from_millis(self.flush_interval_ms.max(1)),
        )
    }
}

/// Build the shared client with hard timeouts so a stalled backend releases the
/// task and socket instead of pinning them for the whole run.
fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(HEARTBEAT_REQUEST_TIMEOUT)
        .connect_timeout(HEARTBEAT_CONNECT_TIMEOUT)
        .build()
        .expect("heartbeat reqwest client builds with static timeouts")
}

pub(crate) struct BenchHeartbeatReporter {
    http: reqwest::Client,
    stats_token: Arc<str>,
    heartbeat_url: Arc<str>,
    inflight: Arc<Semaphore>,
    flush_interval: Duration,
    tunnel_id: String,
    actions: u64,
    last_flush: Option<Instant>,
    last_nonce: u64,
}

impl BenchHeartbeatReporter {
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
            tunnel_id: String::new(),
            actions: 0,
            last_flush: None,
            last_nonce: 0,
        }
    }

    fn start(&mut self, tunnel_id: &str) {
        self.tunnel_id = tunnel_id.to_string();
        self.actions = 0;
        self.last_flush = Some(Instant::now());
        self.last_nonce = 0;
    }

    fn record(&mut self, ev: &MoveCommitted) -> Option<HeartbeatPayload> {
        self.actions += 1;
        self.last_nonce = ev.nonce;
        let now = Instant::now();
        let base = self.last_flush.get_or_insert(now);
        let window = now.saturating_duration_since(*base);
        if window >= self.flush_interval {
            self.flush(now, window)
        } else {
            None
        }
    }

    fn drain(&mut self) -> Option<HeartbeatPayload> {
        if self.actions == 0 {
            return None;
        }
        let now = Instant::now();
        let base = self.last_flush.unwrap_or(now);
        self.flush(now, now.saturating_duration_since(base))
    }

    fn flush(&mut self, now: Instant, window: Duration) -> Option<HeartbeatPayload> {
        if self.actions == 0 {
            return None;
        }
        let payload = HeartbeatPayload {
            tunnel_id: self.tunnel_id.clone(),
            nonce: self.last_nonce.to_string(),
            actions_delta: self.actions,
            window_ms: (window.as_millis() as u64).max(1),
        };
        self.actions = 0;
        self.last_flush = Some(now);
        Some(payload)
    }

    fn dispatch(&self, payload: HeartbeatPayload) {
        // Reserve an in-flight slot before spawning. If the cap is saturated
        // (only a slow/hung backend gets here), drop the sample: telemetry must
        // never block or await on the driver's hot path.
        let Ok(permit) = Arc::clone(&self.inflight).try_acquire_owned() else {
            tracing::debug!("fleet-bench heartbeat dropped: in-flight cap reached");
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
                tracing::warn!(%error, "fleet-bench heartbeat post failed");
            }
        });
    }
}

impl DriverObserver for BenchHeartbeatReporter {
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
impl BenchHeartbeatReporter {
    /// Test-only constructor that injects a specific in-flight budget so the
    /// drop-under-saturation path is observable without a full run.
    fn for_test(http: reqwest::Client, heartbeat_url: Arc<str>, inflight: Arc<Semaphore>) -> Self {
        Self::new(
            http,
            Arc::from("tok"),
            heartbeat_url,
            inflight,
            Duration::from_millis(1),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn sample_payload() -> HeartbeatPayload {
        HeartbeatPayload {
            tunnel_id: "tunnel-1".to_string(),
            nonce: "1".to_string(),
            actions_delta: 1,
            window_ms: 1,
        }
    }

    #[tokio::test]
    async fn setup_registers_session_before_heartbeats() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/sessions"))
            .and(body_json(serde_json::json!({
                "userAddress": "fleet-bench",
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
            &*config.heartbeat_url,
            format!("{}/v1/sessions/sess-1/heartbeat", server.uri())
        );
    }

    #[tokio::test]
    async fn dispatch_drops_instead_of_blocking_when_inflight_cap_reached() {
        let inflight = Arc::new(Semaphore::new(1));
        // Hold the only permit so the cap is saturated.
        let held = Arc::clone(&inflight)
            .try_acquire_owned()
            .expect("initial permit");

        let reporter = BenchHeartbeatReporter::for_test(
            reqwest::Client::new(),
            // Unreachable on purpose: a saturated cap must never spawn a post.
            Arc::from("http://127.0.0.1:9/v1/sessions/x/heartbeat"),
            Arc::clone(&inflight),
        );

        // Returns promptly without blocking; nothing is spawned.
        reporter.dispatch(sample_payload());
        assert_eq!(inflight.available_permits(), 0);

        // The only outstanding permit is still the one we hold.
        drop(held);
        assert_eq!(inflight.available_permits(), 1);
    }

    #[tokio::test]
    async fn dispatch_releases_permit_after_post_completes() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/sessions/sess/heartbeat"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let inflight = Arc::new(Semaphore::new(1));
        let url: Arc<str> = format!("{}/v1/sessions/sess/heartbeat", server.uri()).into();
        let reporter =
            BenchHeartbeatReporter::for_test(reqwest::Client::new(), url, Arc::clone(&inflight));

        reporter.dispatch(sample_payload());

        // The spawned task holds the permit until the POST resolves, then frees
        // it. Poll (bounded) so a regression that leaks permits fails fast.
        let mut released = false;
        for _ in 0..200 {
            if inflight.available_permits() == 1 {
                released = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(released, "permit was not released after the post completed");
    }
}
