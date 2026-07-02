//! Read-only explorer API. Stateless; scales horizontally. Verification is client-side
//! (Phase 3) — this only serves rows + proxies the Walrus blob + fans out live rows.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderName, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use shared::{LifecycleKind, SettlementQuery, SettlementStore};
use transcript_store::{TranscriptChunkReader, TranscriptReader};

/// Names the transcript wire format so the browser verifier picks the right decode path: the
/// server-owned streamed chunks are entries-only (root/balances come from the settlement row), while
/// the legacy Walrus blob is a whole settle body (header + entries).
const TRANSCRIPT_FORMAT_HEADER: &str = "x-transcript-format";
const FORMAT_ENTRIES: &str = "entries";
const FORMAT_BODY: &str = "body";

#[derive(Clone)]
pub struct ApiState {
    pub store: Arc<dyn SettlementStore>,
    pub walrus_aggregator_url: String,
    pub http: reqwest::Client,
    /// Reassembles the bot-streamed transcript chunks. `None` = no S3 configured; `/transcript`
    /// then serves only the legacy one-object Walrus blob.
    pub chunks: Option<Arc<dyn TranscriptChunkReader>>,
    /// Reads the one-object S3 settle archive (ADR-0024): the co-signed settle body, keyed by
    /// `(tunnel_id, tx_digest)`. Same S3 store as `chunks`; the settle path archives every
    /// cooperative close here, so this is the primary Walrus replacement for closes that carry no
    /// streamed chunks. `None` = no S3 configured.
    pub archive: Option<Arc<dyn TranscriptReader>>,
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

/// Serve a settlement's transcript for the in-browser verifier. Source order: server-owned streamed
/// chunks (entries-only; the verifier reads root/balances from the settlement row) → the one-object
/// S3 settle archive (a whole settle body) → the legacy Walrus blob (also a whole body). The S3
/// archive is the primary Walrus replacement; Walrus remains only for closes archived before S3. The
/// `x-transcript-format` header tells the verifier which decode path to take. 404 when no source has
/// the transcript.
async fn transcript(State(s): State<ApiState>, Path(digest): Path<String>) -> Response {
    let row = match s.store.get(&digest).await {
        Ok(Some(row)) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "no such settlement").into_response(),
        Err(e) => {
            tracing::error!(error = %e, "settlement store error");
            return (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response();
        }
    };
    // Chunks are the source of truth once the bot owns the transcript; a transient S3 error falls
    // through to Walrus rather than failing, so verification degrades gracefully mid-migration.
    if let Some(chunks) = &s.chunks {
        match chunks.read_transcript(&row.tunnel_id).await {
            Ok(Some(bytes)) => {
                return (
                    [
                        (CONTENT_TYPE, "application/octet-stream"),
                        (
                            HeaderName::from_static(TRANSCRIPT_FORMAT_HEADER),
                            FORMAT_ENTRIES,
                        ),
                    ],
                    bytes,
                )
                    .into_response();
            }
            Ok(None) => {} // no chunks for this tunnel — try the one-object archive next
            Err(e) => {
                tracing::warn!(error = %e, tunnel = %row.tunnel_id, "chunk read failed; trying archive");
            }
        }
    }
    // One-object S3 settle archive: the co-signed settle body keyed by (tunnel_id, tx_digest). Same
    // whole-body wire format as the Walrus blob, so it serves as FORMAT_BODY. A transient S3 error
    // falls through to Walrus rather than failing.
    if let Some(archive) = &s.archive {
        match archive.read(&row.tunnel_id, &digest).await {
            Ok(Some(bytes)) => {
                return (
                    [
                        (CONTENT_TYPE, "application/octet-stream"),
                        (
                            HeaderName::from_static(TRANSCRIPT_FORMAT_HEADER),
                            FORMAT_BODY,
                        ),
                    ],
                    bytes,
                )
                    .into_response();
            }
            Ok(None) => {} // not archived here — fall back to the Walrus blob
            Err(e) => {
                tracing::warn!(error = %e, tunnel = %row.tunnel_id, "archive read failed; trying Walrus");
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
            // honest type so non-browser consumers (curl, CDN sniff) don't mishandle binary. The
            // format header marks it a whole settle body (header + entries), not entries-only chunks.
            Ok(body) => (
                [
                    (CONTENT_TYPE, "application/octet-stream"),
                    (
                        HeaderName::from_static(TRANSCRIPT_FORMAT_HEADER),
                        FORMAT_BODY,
                    ),
                ],
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

/// Peak-preserving TPS from the cumulative `total_actions` counter. `cumulative` is (ts, total)
/// ascending at fetch resolution (≈1s for live windows); the returned (ts, rate) keeps the MAX
/// per-sample rate within each `display_stride`-wide bucket, so a short burst survives the
/// downsample instead of being averaged away — the Grafana `max_over_time` / RRDtool MAX pattern.
/// Deriving the average between coarse buckets is what flattened a 1M burst to ~115k on the 1D view.
///
/// An interval wider than `gap_max_secs` is a data gap (indexer downtime) and is dropped, not
/// smeared: the lone cross-gap sample would otherwise paint the whole gap's accrual as one fake
/// spike (the "last night" 11k/112k artifact). A counter that goes backwards (Redis flush /
/// restart) contributes 0, never a negative rate.
pub(crate) fn peak_tps_points(
    cumulative: &[(i64, i64)],
    display_stride: i64,
    gap_max_secs: i64,
) -> Vec<(i64, f64)> {
    let stride = display_stride.max(1);
    // display-bucket key → (ts of the peak sample in that bucket, its rate). BTreeMap keeps the
    // buckets in ascending order, so the collected points come out time-sorted.
    let mut buckets: std::collections::BTreeMap<i64, (i64, f64)> =
        std::collections::BTreeMap::new();
    for w in cumulative.windows(2) {
        let (t0, v0) = w[0];
        let (t1, v1) = w[1];
        let dt = t1 - t0;
        if dt <= 0 || dt > gap_max_secs {
            continue; // non-advancing or a data gap → not a real rate
        }
        let rate = (v1 - v0).max(0) as f64 / dt as f64;
        let entry = buckets.entry(t1 / stride).or_insert((t1, rate));
        if rate > entry.1 {
            *entry = (t1, rate);
        }
    }
    buckets.into_values().collect()
}

/// Fetch resolution (seconds/sample) pulled from the store: full 1s fidelity for live windows,
/// coarsening only enough to keep a wide (30-day) range within `MAX_FETCH_SAMPLES` rows. Always
/// finer than the display bucket, so peaks still survive the in-memory MAX rollup.
fn fetch_stride_secs(span_secs: i64) -> i64 {
    ((span_secs + MAX_FETCH_SAMPLES - 1) / MAX_FETCH_SAMPLES).max(1)
}

/// metric_bucket is rolled off after 30 days, so that is the furthest back any range can reach.
const HISTORY_RETENTION_SECS: i64 = 30 * 24 * 3600;
/// Downsample target: a long range (up to 30d ≈ 2.6M rows) is bucketed to at most this many
/// points server-side, bounding both the payload and the client's render cost.
const HISTORY_TARGET_POINTS: i64 = 1000;
/// Cap on rows pulled from the store per history query, so a 30-day range stays bounded. A day of
/// per-second samples is 86,400 — well under this — so all live windows fetch at full 1s fidelity.
const MAX_FETCH_SAMPLES: i64 = 100_000;
/// Floor for the gap threshold: an interval wider than this reads as a data gap (see
/// `peak_tps_points`). 10s clears the observed live spacing (~1s, p90 2s) so normal jitter is never
/// cut; the effective threshold scales up when a coarse fetch stride makes samples legitimately sparse.
const GAP_MIN_SECS: i64 = 10;

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
    let (from, to, display_stride) = history_query_bounds(&p, now);
    // Fetch at fine (≈1s) resolution and MAX-roll up into display buckets, so peaks survive; the
    // store's own coarse bucketing would hand back per-bucket averages and hide short bursts.
    let fetch_stride = fetch_stride_secs((to - from).max(1));
    // A gap is several missed fetch intervals; the floor keeps normal ~1s jitter from being cut.
    let gap_max = (fetch_stride * 3).max(GAP_MIN_SECS);
    match s.store.metric_history(from, to, fetch_stride).await {
        Ok(cum) => {
            let points: Vec<_> = peak_tps_points(&cum, display_stride, gap_max)
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
        let store = InMemorySettlementStore::new();
        for r in rows {
            futures::executor::block_on(store.upsert(r)).unwrap(); // inherent upsert, before Arc<dyn>
        }
        ApiState {
            store: Arc::new(store),
            walrus_aggregator_url: "https://agg.example".into(),
            http: reqwest::Client::new(),
            chunks: None,
            archive: None,
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

    // A short burst inside a display bucket must surface as that bucket's PEAK, not be averaged
    // away — the whole point of the MAX rollup. Regression lock for the "1D shows ~115k for a 1M
    // burst" bug: here one 1s spike of +1,000,000 sits among idle seconds; the average over the
    // 50s bucket is ~20k, so the assertion fails unless the peak is preserved.
    #[test]
    fn peak_bucket_reports_the_burst_peak_not_the_average() {
        let mut cum = vec![(0i64, 0i64)];
        let mut total = 0i64;
        for t in 1..=50i64 {
            total += if t == 25 { 1_000_000 } else { 10 };
            cum.push((t, total));
        }
        let pts = peak_tps_points(&cum, 100, 10);
        assert_eq!(
            pts.len(),
            1,
            "50s inside one 100s display bucket → one point"
        );
        assert!(
            (pts[0].1 - 1_000_000.0).abs() < 1.0,
            "bucket must report the 1e6 burst peak, got {}",
            pts[0].1
        );
    }

    // A data gap (indexer downtime) must NOT be drawn as a rate: the counter climbs while nothing
    // is recorded, so the lone cross-gap sample would smear ~a billion actions over the gap into a
    // fake spike. Regression lock for the "last night" 11k/112k artifact.
    #[test]
    fn large_gap_is_dropped_not_smeared_into_a_fake_spike() {
        let day = 86_400i64;
        let cum = vec![
            (0i64, 0i64),
            (1, 5),
            (1 + day, 1_000_000_000), // 24h gap, +1e9 actions → ~11.5k/s if smeared
            (2 + day, 1_000_000_030),
            (3 + day, 1_000_000_060),
        ];
        let pts = peak_tps_points(&cum, 1, 10);
        assert_eq!(
            pts.len(),
            3,
            "the three real 1s intervals survive; the gap does not"
        );
        assert!(
            pts.iter().all(|&(_, v)| v < 100.0),
            "cross-gap smear leaked a fake spike: {pts:?}"
        );
    }

    // A counter that goes backwards (Redis flush / instance restart) contributes 0, never a
    // negative rate that would invert the line.
    #[test]
    fn counter_reset_contributes_zero_not_a_negative_rate() {
        let cum = vec![(0i64, 1_000_000i64), (1, 1_000_500), (2, 0)];
        let pts = peak_tps_points(&cum, 1, 10);
        assert_eq!(pts.len(), 2);
        assert!(pts.iter().all(|&(_, v)| v >= 0.0), "negative rate: {pts:?}");
    }

    // Fine-fetch stays 1s for live windows (full peak fidelity) and only coarsens enough to bound
    // the row count on a very wide (30-day) range.
    #[test]
    fn fetch_stride_is_full_resolution_until_the_row_budget() {
        assert_eq!(fetch_stride_secs(86_400), 1); // 1 day → per-second
        assert_eq!(fetch_stride_secs(900), 1); // 15 min → per-second
        let thirty_days = 30 * 24 * 3600;
        let s = fetch_stride_secs(thirty_days);
        assert!(s > 1, "30d must coarsen to bound rows");
        assert!(
            thirty_days / s <= MAX_FETCH_SAMPLES,
            "row count must stay within the fetch budget"
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
        let app = router(state_with(vec![settled("a", 10)])); // walrus_blob_id None, chunks None
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

    // When the bot has streamed chunks for the tunnel, /transcript serves the reassembled
    // entries-only bytes and marks the format so the verifier reads root/balances from the row —
    // it must NOT fall back to the (absent) Walrus blob.
    #[tokio::test]
    async fn transcript_serves_reassembled_chunks_as_entries() {
        use transcript_store::testing::FakeChunkStore;
        use transcript_store::{TranscriptChunkWriter, TranscriptManifest};

        let fake = Arc::new(FakeChunkStore::default());
        fake.put_chunk("0xtun", 0, b"co-signed-entry-bytes".to_vec())
            .await
            .unwrap();
        fake.seal("0xtun", &TranscriptManifest::new(1, 21, "0xroot".into(), 1))
            .await
            .unwrap();

        let mut state = state_with(vec![settled("a", 10)]); // tunnel_id "0xtun", no walrus blob
        state.chunks = Some(fake as Arc<dyn TranscriptChunkReader>);
        let app = router(state);

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
        assert_eq!(
            res.headers().get(TRANSCRIPT_FORMAT_HEADER).unwrap(),
            FORMAT_ENTRIES
        );
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], b"co-signed-entry-bytes");
    }

    // No streamed chunks, but the settle path archived the one-object body under (tunnel_id,
    // tx_digest): /transcript serves it as a whole body (FORMAT_BODY) from S3, not 404 and not
    // Walrus. This is the primary Walrus replacement path.
    #[tokio::test]
    async fn transcript_serves_archive_body_when_no_chunks() {
        use transcript_store::testing::FakeReader;

        let mut fake = FakeReader::default();
        fake.objects.insert(
            ("0xtun".into(), "a".into()), // (tunnel_id, tx_digest) — matches settled("a") on 0xtun
            b"co-signed-settle-body".to_vec(),
        );

        let mut state = state_with(vec![settled("a", 10)]); // no walrus blob, no chunks
        state.archive = Some(Arc::new(fake) as Arc<dyn TranscriptReader>);
        let app = router(state);

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
        assert_eq!(
            res.headers().get(TRANSCRIPT_FORMAT_HEADER).unwrap(),
            FORMAT_BODY
        );
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], b"co-signed-settle-body");
    }
}
