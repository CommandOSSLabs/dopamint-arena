//! HTTP handlers for the control-plane contract (ADR-0002). Per-move traffic never
//! reaches here (ADR-0001): only register / heartbeat / settle / live-stats.

use std::convert::Infallible;
use std::sync::atomic::Ordering;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};
use uuid::Uuid;

use crate::error::ApiError;
use crate::state::{AppState, SessionRecord, SharedState};

// ===== Wire types — JSON is camelCase to match the SDK (see ADR-0002). =====
// `u64` fields that exceed JS precision (balances, nonce, timestamp) are strings.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegisterSessionRequest {
    user_address: String,
    game: String,
    tunnels: Vec<TunnelRef>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TunnelRef {
    tunnel_id: String,
    party_a: String,
    party_b: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegisterSessionResponse {
    session_id: String,
    stats_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HeartbeatRequest {
    tunnel_id: String,
    nonce: String,
    actions_delta: u64,
    window_ms: u64,
}

/// Thin envelope over the SDK's `CoSignedSettlementWithRoot` plus the transcript.
/// `{settlement, sig_a, sig_b}` drives the on-chain close; `transcript` is for Walrus only.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettleRequest {
    settlement: Settlement,
    sig_a: String,
    sig_b: String,
    transcript: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settlement {
    tunnel_id: String,
    party_a_balance: String,
    party_b_balance: String,
    final_nonce: String,
    timestamp: String,
    transcript_root: String,
}

pub(crate) async fn health() -> &'static str {
    "ok"
}

/// Register the tunnels a client just opened+funded (via the wallet PTB) under a
/// session, so their stats and settlement can be tracked. Not trusted for funds —
/// on-chain events remain authoritative.
pub(crate) async fn register_session(
    State(state): State<SharedState>,
    Json(req): Json<RegisterSessionRequest>,
) -> Json<RegisterSessionResponse> {
    tracing::info!(user = %req.user_address, game = %req.game, tunnels = req.tunnels.len(), "register session");
    for t in &req.tunnels {
        tracing::debug!(tunnel = %t.tunnel_id, party_a = %t.party_a, party_b = %t.party_b, "registered tunnel");
    }
    let session_id = format!("sess_{}", Uuid::new_v4().simple());
    let stats_token = Uuid::new_v4().to_string();
    // Store the same token we return — every write on this session is bearer-checked
    // against it (Phase 4.2). The field and its writer must land together.
    state.sessions.write().expect("sessions lock").insert(
        session_id.clone(),
        SessionRecord {
            game: req.game,
            tunnels: req.tunnels,
            stats_token: stats_token.clone(),
        },
    );
    Json(RegisterSessionResponse {
        session_id,
        stats_token,
    })
}

/// Coarse, aggregated throughput report (~1/s) — never one call per move.
pub(crate) async fn heartbeat(
    State(state): State<SharedState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<HeartbeatRequest>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    // Resolve the session's game + token (404 if unknown), then bearer-auth.
    let (game, token) = {
        let sessions = state.sessions.read().expect("sessions lock");
        match sessions.get(&session_id) {
            Some(rec) => (rec.game.clone(), rec.stats_token.clone()),
            None => {
                return Err(ApiError::resp(
                    StatusCode::NOT_FOUND,
                    "unknown_session",
                    "no such session",
                ))
            }
        }
    };
    if !bearer_matches(&headers, &token) {
        return Err(ApiError::resp(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid bearer token",
        ));
    }
    tracing::debug!(%session_id, tunnel = %req.tunnel_id, nonce = %req.nonce, window_ms = req.window_ms, "heartbeat");
    state
        .total_actions
        .fetch_add(req.actions_delta, Ordering::Relaxed);
    attribute_actions(&state, &game, req.actions_delta);
    Ok(StatusCode::NO_CONTENT)
}

/// Validate the settlement and submit `close_cooperative_with_root` on-chain.
/// (Walrus archival lands in Phase 2; the Walrus response fields stay empty until then.)
/// Every malformed field is a `422` — nothing is silently coerced, so a bad signature
/// never becomes empty bytes that fail on-chain with an opaque error.
pub(crate) async fn settle(
    State(state): State<SharedState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SettleRequest>,
) -> Response {
    tracing::info!(
        %session_id,
        tunnel = %req.settlement.tunnel_id,
        final_nonce = %req.settlement.final_nonce,
        balance_a = %req.settlement.party_a_balance,
        balance_b = %req.settlement.party_b_balance,
        transcript_len = req.transcript.len(),
        "settle requested"
    );

    // Existence/ownership (ADR-0002): 404 for an unknown session or a tunnel not in it,
    // then bearer-auth. Scoped so the RwLock read guard drops before the later `.await`.
    let token = {
        let sessions = state.sessions.read().expect("sessions lock");
        match sessions.get(&session_id) {
            None => {
                return ApiError::resp(StatusCode::NOT_FOUND, "unknown_session", "no such session")
                    .into_response()
            }
            Some(rec)
                if !rec
                    .tunnels
                    .iter()
                    .any(|t| t.tunnel_id == req.settlement.tunnel_id) =>
            {
                return ApiError::resp(
                    StatusCode::NOT_FOUND,
                    "unknown_tunnel",
                    "tunnel not registered in session",
                )
                .into_response()
            }
            Some(rec) => rec.stats_token.clone(),
        }
    };
    if !bearer_matches(&headers, &token) {
        return ApiError::resp(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid bearer token",
        )
        .into_response();
    }

    // 409 if the event-derived registry already shows this tunnel closed. Best-effort:
    // the indexer lags the chain by up to one poll, so a racing duplicate still falls
    // through to the on-chain `ETunnelClosed` → 422. Scoped so the guard drops before await.
    // (Keys are the node's canonical 0x object id; the SDK emits the same canonical form.)
    {
        let tunnels = state.tunnels.read().expect("tunnels lock");
        if tunnels.get(&req.settlement.tunnel_id) == Some(&crate::state::TunnelStatus::Closed) {
            return ApiError::resp(
                StatusCode::CONFLICT,
                "already_settled",
                "tunnel already closed on-chain",
            )
            .into_response();
        }
    }

    let a = match parse_u64(&req.settlement.party_a_balance, "partyABalance") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let b = match parse_u64(&req.settlement.party_b_balance, "partyBBalance") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let ts = match parse_u64(&req.settlement.timestamp, "timestamp") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let transcript_root = match decode_hex(&req.settlement.transcript_root, "transcriptRoot") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let sig_a = match decode_hex(&req.sig_a, "sigA") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let sig_b = match decode_hex(&req.sig_b, "sigB") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };

    let close = crate::sui::CloseArgs {
        tunnel_id: req.settlement.tunnel_id.clone(),
        party_a_balance: a,
        party_b_balance: b,
        sig_a,
        sig_b,
        timestamp: ts,
        transcript_root,
    };
    match state.settler.submit_close(close).await {
        Ok(digest) => {
            // The settled count is now event-derived (the indexer maintains it); no manual
            // increment here, or it would double-count once the indexer also sees the close.
            // Archive the transcript to Walrus. The on-chain close already succeeded, so
            // an archival failure is reported (empty fields) but does NOT fail the settle.
            let blob = serde_json::to_vec(&req.transcript).unwrap_or_default();
            let (blob_id, proof_url) = match state.walrus.upload_transcript(blob).await {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!(%digest, error = %e, "walrus archival failed");
                    (String::new(), String::new())
                }
            };
            Json(serde_json::json!({ "txDigest": digest, "walrusBlobId": blob_id, "proofUrl": proof_url }))
                .into_response()
        }
        Err(e) => ApiError::resp(
            StatusCode::UNPROCESSABLE_ENTITY,
            "settle_failed",
            &e.to_string(),
        )
        .into_response(),
    }
}

/// Parse a decimal-string `u64` field (ADR-0002 sends balances/timestamp as strings),
/// mapping a bad value to `422` rather than panicking.
pub(crate) fn parse_u64(s: &str, field: &str) -> Result<u64, (StatusCode, Json<ApiError>)> {
    s.parse::<u64>().map_err(|_| {
        ApiError::resp(
            StatusCode::UNPROCESSABLE_ENTITY,
            "bad_settlement",
            &format!("field `{field}` is not a u64: {s:?}"),
        )
    })
}

/// Decode a `0x`-prefixed hex field (sigs, transcript root), mapping bad hex to `422`.
fn decode_hex(s: &str, field: &str) -> Result<Vec<u8>, (StatusCode, Json<ApiError>)> {
    hex::decode(s.trim_start_matches("0x")).map_err(|_| {
        ApiError::resp(
            StatusCode::UNPROCESSABLE_ENTITY,
            "bad_settlement",
            &format!("field `{field}` is not hex"),
        )
    })
}

/// True iff `Authorization: Bearer <token>` is present and equals `expected`.
fn bearer_matches(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|t| t == expected)
        .unwrap_or(false)
}

/// Attribute `delta` off-chain actions to `game`, maintained at heartbeat write time
/// (the broadcaster turns the per-tick delta into per-game TPS).
fn attribute_actions(state: &AppState, game: &str, delta: u64) {
    *state
        .per_game_actions
        .write()
        .expect("per_game lock")
        .entry(game.to_owned())
        .or_insert(0) += delta;
}

/// SSE feed for the catalog activity panel (ADR-0002 `GET /v1/stats/live`).
/// Each viewer subscribes to the broadcast channel; the snapshot is computed ONCE
/// per tick by `spawn_stats_broadcaster` and fanned out to all of them — so cost
/// scales with the audience, never with TPS.
pub(crate) async fn stats_live(
    State(state): State<SharedState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(state.stats_tx.subscribe()).filter_map(|msg| {
        msg.ok()
            .map(|json| Ok::<_, Infallible>(Event::default().data(json)))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Prometheus text exposition of the live counters (hand-rolled to avoid a metrics-crate
/// dependency for three counters). Same atomics the SSE snapshot reads.
pub(crate) async fn metrics(State(state): State<SharedState>) -> impl IntoResponse {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4",
        )],
        render_metrics(&state),
    )
}

fn render_metrics(state: &AppState) -> String {
    use std::sync::atomic::Ordering::Relaxed;
    format!(
        "# TYPE tunnel_actions_total counter\ntunnel_actions_total {}\n\
         # TYPE tunnel_settled_total counter\ntunnel_settled_total {}\n\
         # TYPE tunnel_active gauge\ntunnel_active {}\n",
        state.total_actions.load(Relaxed),
        state.settled_tunnels.load(Relaxed),
        state.active_tunnels.load(Relaxed),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // The settle payload MUST deserialize from the exact camelCase JSON the SDK
    // emits (buildSettlementWithRoot + transcript). A rename here is an
    // integration break with the 4 game clients — this test pins the contract.
    // `finalNonce` is the SDK's signed value = onchainNonce + 1 (= "1" in self-play),
    // NOT the off-chain move count (see ADR-0002 finalNonce note).
    #[test]
    fn settle_request_matches_sdk_camelcase_json() {
        let json = r#"{
            "settlement": {
                "tunnelId": "0x1", "partyABalance": "1500", "partyBBalance": "500",
                "finalNonce": "1", "timestamp": "1750000000000", "transcriptRoot": "0xabc"
            },
            "sigA": "0xaa", "sigB": "0xbb", "transcript": []
        }"#;
        let req: SettleRequest = serde_json::from_str(json).expect("valid settle payload");
        assert_eq!(req.settlement.tunnel_id, "0x1");
        assert_eq!(req.settlement.party_a_balance, "1500");
        assert_eq!(req.settlement.final_nonce, "1");
        assert_eq!(req.sig_a, "0xaa");
        assert!(req.transcript.is_empty());
    }

    // The wire contract sends u64s as decimal strings and sigs/root as hex; garbage in
    // either must be a clean 422, never a panic.
    #[test]
    fn parse_helpers_reject_garbage() {
        assert!(parse_u64("not-a-number", "partyABalance").is_err());
        assert_eq!(parse_u64("1500", "partyABalance").unwrap(), 1500);
        assert!(decode_hex("zz", "sigA").is_err());
        assert_eq!(decode_hex("0x00ff", "sigA").unwrap(), vec![0, 255]);
    }

    // Only an exact `Bearer <token>` authorizes a write; missing header, wrong token, and
    // a non-Bearer value all fail. This is the auth contract for heartbeat/settle.
    #[test]
    fn bearer_matches_only_exact_token() {
        let mut h = HeaderMap::new();
        assert!(!bearer_matches(&h, "tok"), "missing header must fail");
        h.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer wrong".parse().unwrap(),
        );
        assert!(!bearer_matches(&h, "tok"), "wrong token must fail");
        h.insert(axum::http::header::AUTHORIZATION, "tok".parse().unwrap());
        assert!(
            !bearer_matches(&h, "tok"),
            "missing Bearer prefix must fail"
        );
        h.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer tok".parse().unwrap(),
        );
        assert!(bearer_matches(&h, "tok"), "exact token must pass");
    }

    // Heartbeat deltas must accrue to the session's game; the snapshot reports per-game
    // cumulative totals (the basis for per-game TPS).
    #[test]
    fn heartbeats_attribute_actions_per_game() {
        let state = test_state();
        register(&state, "s_bj", "blackjack");
        register(&state, "s_pay", "payments");
        attribute_actions(&state, "blackjack", 1000);
        attribute_actions(&state, "payments", 250);
        attribute_actions(&state, "blackjack", 200);
        let snap = crate::stats::build_snapshot(&state, 0);
        assert_eq!(snap.per_game["blackjack"].total_actions, 1200);
        assert_eq!(snap.per_game["payments"].total_actions, 250);
    }

    // /metrics must expose the live counters in Prometheus text format with their values.
    #[test]
    fn metrics_render_exposes_counters() {
        let state = test_state();
        state
            .total_actions
            .fetch_add(42, std::sync::atomic::Ordering::Relaxed);
        let body = render_metrics(&state);
        assert!(body.contains("tunnel_actions_total 42"), "got: {body}");
        assert!(body.contains("# TYPE tunnel_active gauge"));
    }

    fn register(state: &AppState, id: &str, game: &str) {
        state.sessions.write().unwrap().insert(
            id.to_string(),
            SessionRecord {
                game: game.into(),
                tunnels: vec![],
                stats_token: "tok".into(),
            },
        );
    }

    fn test_state() -> SharedState {
        use base64::Engine;
        use std::collections::HashMap;
        use std::sync::atomic::AtomicU64;
        use std::sync::RwLock;
        let key = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
        let settler = crate::sui::SuiSettler::new(
            "http://127.0.0.1:9999".into(),
            "0x2",
            "0x2::sui::SUI",
            &key,
        )
        .expect("test settler");
        let walrus = crate::walrus::WalrusClient::new("http://pub".into(), "http://agg".into());
        let (stats_tx, _) = tokio::sync::broadcast::channel(4);
        std::sync::Arc::new(AppState {
            sessions: RwLock::new(HashMap::new()),
            total_actions: AtomicU64::new(0),
            active_tunnels: AtomicU64::new(0),
            settled_tunnels: AtomicU64::new(0),
            tunnels: RwLock::new(HashMap::new()),
            per_game_actions: RwLock::new(HashMap::new()),
            settler,
            walrus,
            stats_tx,
            presence: RwLock::new(HashMap::new()),
            queues: RwLock::new(HashMap::new()),
            invites: RwLock::new(HashMap::new()),
            matches: RwLock::new(HashMap::new()),
            conns: RwLock::new(HashMap::new()),
        })
    }
}
