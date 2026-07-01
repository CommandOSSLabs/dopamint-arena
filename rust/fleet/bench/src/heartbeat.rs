//! Fleet-bench heartbeat configuration and observer.
//!
//! The payload shape is shared with `fleet-serve`, but bench windows by wall
//! clock instead of the driver's synthetic deterministic timestamps.

use std::time::{Duration, Instant};

use fleet_serve::HeartbeatPayload;
use serde::{Deserialize, Serialize};
use tunnel_harness::{DriverObserver, DriverOutcome, DriverStart, MoveCommitted};

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

        Ok(HeartbeatConfig {
            base_url: self.base_url.clone(),
            session_id: response.session_id,
            stats_token: response.stats_token,
            flush_interval_ms: self.flush_interval_ms,
        })
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeartbeatConfig {
    pub base_url: String,
    pub session_id: String,
    pub stats_token: String,
    pub flush_interval_ms: u64,
}

impl HeartbeatConfig {
    pub(crate) fn reporter(&self) -> BenchHeartbeatReporter {
        BenchHeartbeatReporter::new(
            reqwest::Client::new(),
            self.base_url.clone(),
            self.session_id.clone(),
            self.stats_token.clone(),
            Duration::from_millis(self.flush_interval_ms.max(1)),
        )
    }
}

pub(crate) struct BenchHeartbeatReporter {
    http: reqwest::Client,
    base_url: String,
    session_id: String,
    stats_token: String,
    flush_interval: Duration,
    tunnel_id: String,
    actions: u64,
    last_flush: Option<Instant>,
    last_nonce: u64,
}

impl BenchHeartbeatReporter {
    fn new(
        http: reqwest::Client,
        base_url: String,
        session_id: String,
        stats_token: String,
        flush_interval: Duration,
    ) -> Self {
        Self {
            http,
            base_url,
            session_id,
            stats_token,
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
        let http = self.http.clone();
        let url = format!(
            "{}/v1/sessions/{}/heartbeat",
            self.base_url, self.session_id
        );
        let stats_token = self.stats_token.clone();
        tokio::spawn(async move {
            let result = http
                .post(url)
                .bearer_auth(stats_token)
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
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

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

        assert_eq!(config.base_url, server.uri());
        assert_eq!(config.session_id, "sess-1");
        assert_eq!(config.stats_token, "tok-1");
        assert_eq!(config.flush_interval_ms, 250);
    }
}
