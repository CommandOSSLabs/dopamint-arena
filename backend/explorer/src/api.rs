//! Read-only explorer API. Stateless; scales horizontally. Verification is client-side
//! (Phase 3) — this only serves rows + proxies the Walrus blob + fans out live rows.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use shared::{LifecycleKind, SettlementQuery, SettlementStore};

#[derive(Clone)]
pub struct ApiState {
    pub store: Arc<dyn SettlementStore>,
    pub walrus_aggregator_url: String,
    pub http: reqwest::Client,
    /// S3 is the primary transcript source (the settle route archives the co-signed body
    /// there); `None` when unconfigured → Walrus-only. Missing objects fall back to Walrus.
    pub s3: Option<Arc<dyn transcript_store::TranscriptReader>>,
}

#[derive(serde::Deserialize)]
pub struct ListParams {
    pub cursor: Option<String>, // opaque "{ts}:{digest}" keyset token (composite)
    pub limit: Option<i64>,
    pub tunnel: Option<String>,
    pub address: Option<String>,
    pub kind: Option<String>,
}

pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/v1/settlements", get(list))
        .route("/v1/settlements/:digest", get(detail))
        .route("/v1/settlements/:digest/transcript", get(transcript))
        .route("/v1/stats/explorer", get(stats))
        .route("/v1/stats/history", get(stats_history))
        .route("/health/ready", get(|| async { StatusCode::OK }))
        .with_state(state)
}

async fn list(State(s): State<ApiState>, Query(p): Query<ListParams>) -> Response {
    let q = SettlementQuery {
        cursor: p.cursor,
        limit: p.limit.unwrap_or(50).clamp(1, 200),
        tunnel_id: p.tunnel,
        address: p.address,
        kind: p.kind.as_deref().and_then(LifecycleKind::from_db_str),
    };
    match s.store.list(&q).await {
        Ok(page) => Json(page).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "settlement store error");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

async fn detail(State(s): State<ApiState>, Path(digest): Path<String>) -> Response {
    match s.store.get(&digest).await {
        Ok(Some(row)) => Json(row).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "no such settlement").into_response(),
        Err(e) => {
            tracing::error!(error = %e, "settlement store error");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

/// Serve the archived transcript. **S3 primary** — the settle route archives the co-signed
/// settle body to S3 at a deterministic key; we read it back so verification (client-side)
/// runs on the same bytes. Falls back to proxying the **Walrus** blob when S3 is unconfigured
/// or the object is absent (cutover safety). 404 when neither has it.
async fn transcript(State(s): State<ApiState>, Path(digest): Path<String>) -> Response {
    let row = match s.store.get(&digest).await {
        Ok(Some(row)) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "no such settlement").into_response(),
        Err(e) => {
            tracing::error!(error = %e, "settlement store error");
            return (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response();
        }
    };
    if let Some(s3) = &s.s3 {
        match s3.read(&row.tunnel_id, &digest).await {
            Ok(Some(bytes)) => {
                return (
                    [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
                    bytes,
                )
                    .into_response();
            }
            Ok(None) => {} // not in S3 (yet) → fall back to Walrus
            Err(e) => {
                tracing::warn!(error = %e, digest, "s3 transcript read failed; trying walrus");
            }
        }
    }
    let Some(blob_id) = row.walrus_blob_id else {
        return (
            StatusCode::NOT_FOUND,
            "settlement has no archived transcript",
        )
            .into_response();
    };
    let url = format!(
        "{}/v1/blobs/{}",
        s.walrus_aggregator_url.trim_end_matches('/'),
        blob_id
    );
    match s
        .http
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
    {
        Ok(resp) => match resp.bytes().await {
            // The blob is opaque to us — v2 transcripts are binary (octet-stream); legacy v1 blobs
            // are JSON but the in-browser verifier reads them as bytes either way. Advertise the
            // honest type so non-browser consumers (curl, CDN sniff) don't mishandle binary.
            Ok(body) => (
                [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
                body,
            )
                .into_response(),
            Err(e) => (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
        },
        Err(e) => (StatusCode::BAD_GATEWAY, format!("walrus fetch failed: {e}")).into_response(),
    }
}

async fn stats(State(s): State<ApiState>) -> Response {
    match s.store.settled_count().await {
        Ok(n) => Json(serde_json::json!({ "settledCount": n })).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "settlement store error");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

/// Per-second TPS = the discrete derivative of the cumulative `total_actions` series. Pairs of
/// adjacent buckets where time advanced; the negative-delta guard tolerates a counter reset.
pub(crate) fn derive_tps_points(cumulative: &[(i64, i64)]) -> Vec<(i64, f64)> {
    cumulative
        .windows(2)
        .filter_map(|w| {
            let (t0, v0) = w[0];
            let (t1, v1) = w[1];
            let dt = t1 - t0;
            (dt > 0).then(|| (t1, (v1 - v0).max(0) as f64 / dt as f64))
        })
        .collect()
}

/// metric_bucket is rolled off after 30 days, so that is the furthest back any range can reach.
const HISTORY_RETENTION_SECS: i64 = 30 * 24 * 3600;
/// Downsample target: a long range (up to 30d ≈ 2.6M rows) is bucketed to at most this many
/// points server-side, bounding both the payload and the client's render cost.
const HISTORY_TARGET_POINTS: i64 = 1000;

#[derive(serde::Deserialize)]
pub(crate) struct HistoryParams {
    /// Trailing window in seconds (default 1h). Ignored when an absolute `from`+`to` is given.
    window: Option<i64>,
    /// Absolute range in epoch-seconds; both must be present to take effect.
    from: Option<i64>,
    to: Option<i64>,
}

/// Resolve query params to `(from, to, stride)` epoch-seconds. An absolute `from`+`to` wins over
/// `window`; the result is bounded to the retained 30-day window and `stride` downsamples the
/// range to ≤ HISTORY_TARGET_POINTS buckets. Pure (takes `now`) so the bounds are unit-testable.
pub(crate) fn history_query_bounds(p: &HistoryParams, now: i64) -> (i64, i64, i64) {
    let earliest = now - HISTORY_RETENTION_SECS;
    let (raw_from, raw_to) = match (p.from, p.to) {
        (Some(f), Some(t)) => (f, t),
        _ => {
            let window = p.window.unwrap_or(3600).clamp(1, HISTORY_RETENTION_SECS);
            (now - window, now)
        }
    };
    let to = raw_to.clamp(earliest, now);
    let from = raw_from.clamp(earliest, to);
    let span = (to - from).max(1);
    // Ceil-divide so the bucket count never exceeds the target (floor would overshoot by one).
    let stride = ((span + HISTORY_TARGET_POINTS - 1) / HISTORY_TARGET_POINTS).max(1);
    (from, to, stride)
}

async fn stats_history(State(s): State<ApiState>, Query(p): Query<HistoryParams>) -> Response {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let (from, to, stride) = history_query_bounds(&p, now);
    match s.store.metric_history(from, to, stride).await {
        Ok(cum) => {
            let points: Vec<_> = derive_tps_points(&cum)
                .into_iter()
                .map(|(t, v)| serde_json::json!({ "t": t.to_string(), "v": v }))
                .collect();
            Json(serde_json::json!({ "metric": "tps", "points": points })).into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "metric_history");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request;
    use shared::memory::InMemorySettlementStore;
    use shared::{LifecycleKind, SettlementRow};
    use tower::ServiceExt; // oneshot

    fn state_with(rows: Vec<SettlementRow>) -> ApiState {
        state_with_s3(rows, None)
    }

    fn state_with_s3(
        rows: Vec<SettlementRow>,
        s3: Option<Arc<dyn transcript_store::TranscriptReader>>,
    ) -> ApiState {
        let store = InMemorySettlementStore::new();
        for r in rows {
            futures::executor::block_on(store.upsert(r)).unwrap(); // inherent upsert, before Arc<dyn>
        }
        ApiState {
            store: Arc::new(store),
            walrus_aggregator_url: "https://agg.example".into(),
            http: reqwest::Client::new(),
            s3,
        }
    }

    fn settled(d: &str, ts: i64) -> SettlementRow {
        SettlementRow {
            tx_digest: d.into(),
            kind: LifecycleKind::Settled,
            tunnel_id: "0xtun".into(),
            party_a_addr: Some("0xa".into()),
            party_b_addr: Some("0xb".into()),
            party_a_balance: Some(60),
            party_b_balance: Some(40),
            final_nonce: Some(3),
            transcript_root: Some("aa".into()),
            proof_url: None,
            walrus_blob_id: None,
            checkpoint: 7,
            timestamp_ms: ts,
            closed_at_ms: Some(ts),
            game: None,
        }
    }

    #[tokio::test]
    async fn list_returns_newest_first_json() {
        let app = router(state_with(vec![settled("a", 10), settled("b", 20)]));
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/v1/settlements?limit=10")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let page: shared::SettlementPage = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            page.rows
                .iter()
                .map(|r| r.tx_digest.clone())
                .collect::<Vec<_>>(),
            ["b", "a"]
        );
    }

    #[tokio::test]
    async fn detail_404_for_unknown_digest() {
        let app = router(state_with(vec![]));
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/v1/settlements/nope")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn derive_tps_points_is_the_counter_derivative() {
        let cumulative = vec![(100i64, 10i64), (101, 25), (103, 55)];
        assert_eq!(
            derive_tps_points(&cumulative),
            vec![(101i64, 15.0), (103i64, 15.0)]
        );
    }

    fn params(window: Option<i64>, from: Option<i64>, to: Option<i64>) -> HistoryParams {
        HistoryParams { window, from, to }
    }

    #[test]
    fn history_bounds_default_is_trailing_hour() {
        let now = 1_000_000;
        let (from, to, stride) = history_query_bounds(&params(None, None, None), now);
        assert_eq!((from, to), (now - 3600, now));
        assert_eq!(stride, 4); // ceil(3600 / 1000)
    }

    #[test]
    fn history_bounds_absolute_range_overrides_window() {
        let now = 1_000_000;
        let (from, to, stride) =
            history_query_bounds(&params(Some(900), Some(now - 100), Some(now - 10)), now);
        assert_eq!((from, to), (now - 100, now - 10));
        assert_eq!(stride, 1); // 90s span ≤ target → full resolution
    }

    #[test]
    fn history_bounds_clamp_future_to_now_and_far_past_to_retention() {
        let now = 5_000_000;
        let (from, to, _) = history_query_bounds(&params(None, Some(0), Some(now + 99_999)), now);
        assert_eq!(to, now);
        assert_eq!(from, now - HISTORY_RETENTION_SECS);
    }

    #[test]
    fn history_bounds_downsamples_long_range_within_target() {
        let now = 5_000_000;
        let (from, to, stride) =
            history_query_bounds(&params(Some(HISTORY_RETENTION_SECS), None, None), now);
        assert!((to - from) / stride <= HISTORY_TARGET_POINTS);
    }

    #[tokio::test]
    async fn transcript_404_when_no_blob() {
        let app = router(state_with(vec![settled("a", 10)])); // walrus_blob_id None
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/v1/settlements/a/transcript")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn transcript_reads_from_s3_when_present() {
        let mut objects = std::collections::HashMap::new();
        objects.insert(
            ("0xtun".to_string(), "a".to_string()),
            b"\x02settle-body-bytes".to_vec(),
        );
        let s3 = Arc::new(transcript_store::testing::FakeReader { objects })
            as Arc<dyn transcript_store::TranscriptReader>;
        let app = router(state_with_s3(vec![settled("a", 10)], Some(s3)));
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/v1/settlements/a/transcript")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], b"\x02settle-body-bytes");
    }

    #[tokio::test]
    async fn transcript_falls_back_to_walrus_path_when_s3_misses() {
        // S3 configured but empty and the row has no walrus blob → the walrus branch is taken
        // and 404s on the missing blob, proving the S3-miss fallthrough (not an S3 hit).
        let s3 = Arc::new(transcript_store::testing::FakeReader {
            objects: std::collections::HashMap::new(),
        }) as Arc<dyn transcript_store::TranscriptReader>;
        let app = router(state_with_s3(vec![settled("a", 10)], Some(s3)));
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/v1/settlements/a/transcript")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }
}
