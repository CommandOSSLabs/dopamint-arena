//! HTTP handlers for the control-plane contract (ADR-0002). Per-move traffic never
//! reaches here (ADR-0001): only register / heartbeat / settle / live-stats.

use std::convert::Infallible;

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
use crate::state::{SessionRecord, SharedState, StatsSnapshot};

#[cfg(test)]
pub(crate) mod test_support {
    use crate::state::{AppState, SharedState};

    /// Shared `AppState` builder for unit tests across modules.
    pub(crate) fn test_state() -> SharedState {
        use base64::Engine;
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
            control: std::sync::Arc::new(crate::store::memory::InMemoryControlStore::default()),
            mp: std::sync::Arc::new(crate::store::memory::InMemoryMpStore::default()),
            bus: std::sync::Arc::new(crate::store::memory::LocalBus::new("test-instance".into())),
            settler,
            walrus,
            stats_tx,
            actions: crate::stats_counter::LocalActionCounter::default(),
        })
    }
}

// ===== Wire types — JSON is camelCase to match the SDK (see ADR-0002). =====
// `u64` fields that exceed JS precision (balances, nonce, timestamp) are strings.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegisterSessionRequest {
    user_address: String,
    game: String,
    tunnels: Vec<TunnelRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelRef {
    pub tunnel_id: String,
    pub party_a: String,
    pub party_b: String,
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
    // Opaque to the backend — only counted and forwarded to Walrus verbatim. `RawValue` keeps each
    // entry as the unparsed source slice, so a long transcript stays ~1× its wire size instead of
    // ballooning into a `Value` tree (the headroom that lets `/settle` accept a 16 MB body safely).
    transcript: Vec<Box<serde_json::value::RawValue>>,
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

pub(crate) async fn live() -> StatusCode {
    StatusCode::OK
}

/// 200 iff the CACHE cluster answers. Pubsub is a WS-path soft dependency and is intentionally
/// NOT pinged here (else a pubsub blip would 503 stats/settle and the ALB would drop all targets).
pub(crate) async fn ready(State(state): State<SharedState>) -> StatusCode {
    if state.control.ready().await {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
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
    state
        .control
        .put_session(
            &session_id,
            SessionRecord {
                game: req.game,
                tunnels: req.tunnels,
                stats_token: stats_token.clone(),
            },
        )
        .await;
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
    let Some(rec) = state.control.get_session(&session_id).await else {
        return Err(ApiError::resp(
            StatusCode::NOT_FOUND,
            "unknown_session",
            "no such session",
        ));
    };
    if !bearer_matches(&headers, &rec.stats_token) {
        return Err(ApiError::resp(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid bearer token",
        ));
    }
    tracing::debug!(%session_id, tunnel = %req.tunnel_id, nonce = %req.nonce, window_ms = req.window_ms, "heartbeat");
    state
        .control
        .add_actions(&rec.game, req.actions_delta)
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// Submit `close_cooperative_with_root` for a tunnel. Authorization is the co-signed settlement
/// itself — the chain re-verifies both seat signatures — so there is NO session/bearer gate
/// (ADR-0007). The settler dry-runs the close before sponsoring gas, so a bad settlement is
/// rejected (422) at no cost.
pub(crate) async fn settle(
    State(state): State<SharedState>,
    Path(tunnel_id): Path<String>,
    Json(req): Json<SettleRequest>,
) -> Response {
    tracing::info!(
        %tunnel_id,
        final_nonce = %req.settlement.final_nonce,
        balance_a = %req.settlement.party_a_balance,
        balance_b = %req.settlement.party_b_balance,
        transcript_len = req.transcript.len(),
        "settle requested"
    );

    // The signed settlement commits to its own tunnelId; a path/body mismatch is a client bug
    // or a misroute, never a thing to sponsor gas for.
    if req.settlement.tunnel_id != tunnel_id {
        return ApiError::resp(
            StatusCode::UNPROCESSABLE_ENTITY,
            "tunnel_mismatch",
            "settlement tunnelId does not match the path",
        )
        .into_response();
    }

    // 409 if the event-derived registry already shows this tunnel closed (free reject, no RPC).
    if state.control.get_tunnel_status(&tunnel_id).await == Some(crate::state::TunnelStatus::Closed)
    {
        return ApiError::resp(
            StatusCode::CONFLICT,
            "already_settled",
            "tunnel already closed on-chain",
        )
        .into_response();
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
        tunnel_id: tunnel_id.clone(),
        party_a_balance: a,
        party_b_balance: b,
        sig_a,
        sig_b,
        timestamp: ts,
        transcript_root,
    };
    match state.settler.submit_close(close).await {
        Ok(digest) => {
            // The close landed on-chain: record it in the event-derived registry so a duplicate
            // /settle is rejected for free by the 409 guard above (no chain dry-run). Without this
            // the guard is dead in production, since the in-process chain status poller is disabled.
            state
                .control
                .set_tunnel_status(&tunnel_id, crate::state::TunnelStatus::Closed)
                .await;
            // Archive the SDK `ProofRecord` shape the in-browser verifier consumes — the
            // enclosing { root, entries } object, not a bare entries array. `root` is the
            // co-signed transcript root (same value anchored on-chain), which verifyTranscript
            // re-checks against the recomputed Merkle root and the on-chain anchor.
            let update_count = req.transcript.len();
            // Serialize via a borrowed struct (not `json!`) so the `RawValue` entries stream straight
            // through — `to_value` would re-parse them into a `Value` tree, the cost we just avoided.
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct ProofBlob<'a> {
                tunnel_id: &'a str,
                root: &'a str,
                update_count: usize,
                entries: &'a [Box<serde_json::value::RawValue>],
            }
            let blob = serde_json::to_vec(&ProofBlob {
                tunnel_id: &req.settlement.tunnel_id,
                root: &req.settlement.transcript_root,
                update_count,
                entries: &req.transcript,
            })
            .unwrap_or_default();
            let (blob_id, proof_url) = match state.walrus.upload_transcript(blob).await {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!(%digest, error = %e, "walrus archival failed");
                    (String::new(), String::new())
                }
            };
            state
                .control
                .push_recent_event(settled_event(
                    &tunnel_id,
                    a,
                    b,
                    &req.settlement.transcript_root,
                    &digest,
                    ts,
                    &proof_url,
                ))
                .await;
            if !blob_id.is_empty() {
                let proof_msg = serde_json::json!({
                    "txDigest": digest,
                    "walrusBlobId": blob_id,
                    "proofUrl": proof_url,
                })
                .to_string();
                state.bus.publish_raw("explorer:proofs", proof_msg).await;
            }
            Json(serde_json::json!({ "txDigest": digest, "walrusBlobId": blob_id, "proofUrl": proof_url }))
                .into_response()
        }
        Err(e) => {
            tracing::warn!(tunnel_id = %tunnel_id, error = %e, "settle close failed");
            ApiError::resp(
                StatusCode::UNPROCESSABLE_ENTITY,
                "settle_failed",
                &e.to_string(),
            )
            .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SponsorRequest {
    /// The user's address — the sender of the open/fund tx. Funds (stake) come from this account.
    sender: String,
    /// Base64 of the client-built transaction KIND (`build({ onlyTransactionKind: true })`).
    tx_kind_bytes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SponsorResponse {
    /// Base64 of the full sponsored transaction the user must co-sign and submit.
    tx_bytes: String,
    /// The settler's gas signature (base64), to submit alongside the user's sender signature.
    sponsor_signature: String,
}

/// Sponsor gas (only) for a user's open/fund tx (ADR-0009). Wraps the client-built tx KIND in
/// SIP-58 gas owned by the settler, dry-runs it (verify-before-gas), and returns the bytes + the
/// settler's gas signature. The user co-signs the SAME bytes and submits with both signatures;
/// the stake comes from the user's own coin, never the sponsor. No session/bearer gate — the
/// allowlist + budget cap + dry-run are the only thing standing between this and a gas faucet.
pub(crate) async fn sponsor(
    State(state): State<SharedState>,
    Json(req): Json<SponsorRequest>,
) -> Response {
    match state
        .settler
        .sponsor_open_fund(&req.sender, &req.tx_kind_bytes)
        .await
    {
        Ok((tx_bytes, sponsor_signature)) => Json(SponsorResponse {
            tx_bytes,
            sponsor_signature,
        })
        .into_response(),
        Err(e) => {
            tracing::warn!(sender = %req.sender, error = %e, "sponsor refused");
            ApiError::resp(
                StatusCode::UNPROCESSABLE_ENTITY,
                "sponsor_refused",
                &e.to_string(),
            )
            .into_response()
        }
    }
}

/// Build the settled Transaction-Log row for a successful close. The settle handler owns the
/// full proof (close digest + Walrus URL), so it pushes the enriched row directly; the
/// indexer's later explorer-only row for the same `tx_digest` is deduped. Empty strings
/// (Walrus archival failed) degrade to `None`, never a broken link.
fn settled_event(
    tunnel_id: &str,
    party_a_balance: u64,
    party_b_balance: u64,
    transcript_root_hex: &str,
    tx_digest: &str,
    timestamp_ms: u64,
    proof_url: &str,
) -> crate::state::TunnelEvent {
    let non_empty = |s: &str| (!s.is_empty()).then(|| s.to_string());
    crate::state::TunnelEvent {
        tunnel_id: tunnel_id.to_string(),
        kind: crate::state::TunnelEventKind::Settled,
        party_a_balance: Some(party_a_balance),
        party_b_balance: Some(party_b_balance),
        transcript_root: non_empty(transcript_root_hex),
        tx_digest: tx_digest.to_string(),
        timestamp_ms,
        proof_url: non_empty(proof_url),
    }
}

/// Parse a decimal-string `u64` field, mapping a bad value to `422`.
pub(crate) fn parse_u64(s: &str, field: &str) -> Result<u64, (StatusCode, Json<ApiError>)> {
    s.parse::<u64>().map_err(|_| {
        ApiError::resp(
            StatusCode::UNPROCESSABLE_ENTITY,
            "bad_settlement",
            &format!("field `{field}` is not a u64: {s:?}"),
        )
    })
}

/// Decode a `0x`-prefixed hex field, mapping bad hex to `422`.
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

/// SSE feed for the catalog activity panel (ADR-0002 `GET /v1/stats/live`).
pub(crate) async fn stats_live(
    State(state): State<SharedState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(state.stats_tx.subscribe()).filter_map(|msg| {
        msg.ok()
            .map(|json| Ok::<_, Infallible>(Event::default().data(json)))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Prometheus text exposition of the live counters.
pub(crate) async fn metrics(State(state): State<SharedState>) -> impl IntoResponse {
    let snap = state.control.snapshot().await;
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4",
        )],
        render_metrics(&snap),
    )
}

fn render_metrics(snap: &StatsSnapshot) -> String {
    format!(
        "# TYPE tunnel_actions_total counter\ntunnel_actions_total {}\n\
         # TYPE tunnel_settled_total counter\ntunnel_settled_total {}\n\
         # TYPE tunnel_active gauge\ntunnel_active {}\n",
        snap.total_actions, snap.settled_tunnels, snap.active_tunnels,
    )
}

#[cfg(test)]
mod tests {
    use super::test_support::test_state;
    use super::*;

    // The settle payload MUST deserialize from the exact camelCase JSON the SDK
    // emits (buildSettlementWithRoot + transcript). A rename here is an
    // integration break with the 4 game clients — this test pins the contract.
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

    #[test]
    fn parse_helpers_reject_garbage() {
        assert!(parse_u64("not-a-number", "partyABalance").is_err());
        assert_eq!(parse_u64("1500", "partyABalance").unwrap(), 1500);
        assert!(decode_hex("zz", "sigA").is_err());
        assert_eq!(decode_hex("0x00ff", "sigA").unwrap(), vec![0, 255]);
    }

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

    // A successful settle becomes a `settled` row carrying payout + transcript root + the Walrus
    // proof URL — what makes a global-log row clickable to its proof (spec §6).
    #[test]
    fn settled_event_carries_proof_and_payout() {
        let ev = settled_event(
            "0xT",
            1500,
            500,
            "deadbeef",
            "DiG",
            1_750_000_000_000,
            "https://agg/v1/blobs/abc",
        );
        assert_eq!(ev.kind, crate::state::TunnelEventKind::Settled);
        assert_eq!(ev.party_a_balance, Some(1500));
        assert_eq!(ev.transcript_root.as_deref(), Some("deadbeef"));
        assert_eq!(ev.tx_digest, "DiG");
        assert_eq!(ev.proof_url.as_deref(), Some("https://agg/v1/blobs/abc"));
    }

    // Walrus archival failure (empty url/root) must degrade to an explorer-only row, never a
    // broken link or anchor.
    #[test]
    fn settled_event_omits_proof_on_walrus_failure() {
        let ev = settled_event("0xT", 1, 1, "", "DiG", 1, "");
        assert!(ev.proof_url.is_none(), "empty url → no link");
        assert!(ev.transcript_root.is_none(), "empty root → no anchor");
    }

    // The exact camelCase settle JSON the SDK emits (tunnelId "0x1"), reused by the guard tests.
    const SAMPLE_SETTLE_JSON: &str = r#"{
        "settlement": {
            "tunnelId": "0x1", "partyABalance": "1500", "partyBBalance": "500",
            "finalNonce": "1", "timestamp": "1750000000000", "transcriptRoot": "0xabc"
        },
        "sigA": "0xaa", "sigB": "0xbb", "transcript": []
    }"#;

    // ADR-0007: the signed settlement commits to its tunnelId, so a path/body mismatch is a
    // client bug or a misroute — reject before any RPC, never sponsor gas for it.
    #[tokio::test]
    async fn settle_rejects_path_tunnel_mismatch() {
        let state = test_state();
        let req: SettleRequest = serde_json::from_str(SAMPLE_SETTLE_JSON).unwrap();
        let resp = settle(
            axum::extract::State(state),
            axum::extract::Path("0xDIFFERENT".to_string()),
            axum::Json(req),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    }

    // 409 when the event-derived registry already shows this tunnel closed — a free reject that
    // never reaches the settler (idempotency; ADR-0007 keeps this guard).
    #[tokio::test]
    async fn settle_conflicts_when_already_closed() {
        let state = test_state();
        state
            .control
            .set_tunnel_status("0x1", crate::state::TunnelStatus::Closed)
            .await;
        let req: SettleRequest = serde_json::from_str(SAMPLE_SETTLE_JSON).unwrap();
        let resp = settle(
            axum::extract::State(state),
            axum::extract::Path("0x1".to_string()),
            axum::Json(req),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::CONFLICT);
    }

    // /health/ready reflects ControlStore::ready(); in-memory is always ready.
    #[tokio::test]
    async fn health_ready_reflects_control_store() {
        let state = test_state();
        let code = ready(axum::extract::State(state)).await;
        assert_eq!(code, axum::http::StatusCode::OK);
    }

    // /metrics must expose the live counters in Prometheus text format.
    #[tokio::test]
    async fn metrics_render_exposes_counters() {
        let state = test_state();
        state.control.add_actions("blackjack", 42).await;
        let snap = state.control.snapshot().await;
        let body = render_metrics(&snap);
        assert!(body.contains("tunnel_actions_total 42"), "got: {body}");
        assert!(body.contains("# TYPE tunnel_active gauge"));
    }
}
