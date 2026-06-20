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
}

#[derive(serde::Deserialize)]
pub struct ListParams {
    pub cursor: Option<String>, // opaque "{ts}:{digest}" keyset token (composite)
    pub limit: Option<i64>,
    pub tunnel: Option<String>,
    pub address: Option<String>,
    pub kind: Option<String>,
}

fn parse_kind(s: &str) -> Option<LifecycleKind> {
    match s {
        "opened" => Some(LifecycleKind::Opened),
        "settled" => Some(LifecycleKind::Settled),
        _ => None,
    }
}

pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/v1/settlements", get(list))
        .route("/v1/settlements/:digest", get(detail))
        .route("/v1/settlements/:digest/transcript", get(transcript))
        .route("/v1/stats/explorer", get(stats))
        .route("/health/ready", get(|| async { StatusCode::OK }))
        .with_state(state)
}

async fn list(State(s): State<ApiState>, Query(p): Query<ListParams>) -> Response {
    let q = SettlementQuery {
        cursor: p.cursor,
        limit: p.limit.unwrap_or(50).clamp(1, 200),
        tunnel_id: p.tunnel,
        address: p.address,
        kind: p.kind.as_deref().and_then(parse_kind),
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

/// Proxy the Walrus transcript blob so the browser fetches it same-origin (and we can cache
/// / shield the public aggregator). 404 when the settlement has no archived transcript.
async fn transcript(State(s): State<ApiState>, Path(digest): Path<String>) -> Response {
    let blob_id = match s.store.get(&digest).await {
        Ok(Some(row)) => row.walrus_blob_id,
        Ok(None) => return (StatusCode::NOT_FOUND, "no such settlement").into_response(),
        Err(e) => {
            tracing::error!(error = %e, "settlement store error");
            return (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response();
        }
    };
    let Some(blob_id) = blob_id else {
        return (StatusCode::NOT_FOUND, "settlement has no archived transcript").into_response();
    };
    let url = format!("{}/v1/blobs/{}", s.walrus_aggregator_url.trim_end_matches('/'), blob_id);
    match s.http.get(&url).send().await.and_then(|r| r.error_for_status()) {
        Ok(resp) => match resp.bytes().await {
            Ok(body) => ([(axum::http::header::CONTENT_TYPE, "application/json")], body).into_response(),
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
        }
    }

    fn settled(d: &str, ts: i64) -> SettlementRow {
        SettlementRow {
            tx_digest: d.into(), kind: LifecycleKind::Settled, tunnel_id: "0xtun".into(),
            party_a_addr: Some("0xa".into()), party_b_addr: Some("0xb".into()),
            party_a_balance: Some(60), party_b_balance: Some(40), final_nonce: Some(3),
            transcript_root: Some("aa".into()), proof_url: None, walrus_blob_id: None,
            checkpoint: 7, timestamp_ms: ts, closed_at_ms: Some(ts), game: None,
        }
    }

    #[tokio::test]
    async fn list_returns_newest_first_json() {
        let app = router(state_with(vec![settled("a", 10), settled("b", 20)]));
        let res = app
            .oneshot(Request::builder().uri("/v1/settlements?limit=10").body(axum::body::Body::empty()).unwrap())
            .await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let page: shared::SettlementPage = serde_json::from_slice(&body).unwrap();
        assert_eq!(page.rows.iter().map(|r| r.tx_digest.clone()).collect::<Vec<_>>(), ["b", "a"]);
    }

    #[tokio::test]
    async fn detail_404_for_unknown_digest() {
        let app = router(state_with(vec![]));
        let res = app
            .oneshot(Request::builder().uri("/v1/settlements/nope").body(axum::body::Body::empty()).unwrap())
            .await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn transcript_404_when_no_blob() {
        let app = router(state_with(vec![settled("a", 10)])); // walrus_blob_id None
        let res = app
            .oneshot(Request::builder().uri("/v1/settlements/a/transcript").body(axum::body::Body::empty()).unwrap())
            .await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }
}
