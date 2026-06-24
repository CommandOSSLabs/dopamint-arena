//! Read-only explorer API. Stateless; scales horizontally. Verification is client-side
//! (Phase 3) — this only serves rows + proxies the Walrus blob + fans out live rows.

use std::sync::Arc;

use axum::extract::{Json as JsonBody, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use futures::StreamExt;
use shared::{LifecycleKind, SettlementQuery, SettlementStore};

#[derive(Clone)]
pub struct ApiState {
    pub store: Arc<dyn SettlementStore>,
    pub walrus_aggregator_url: String,
    pub http: reqwest::Client,
    pub llm_base_url: String,
    pub llm_model: String,
    pub llm_api_key: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct ListParams {
    pub cursor: Option<String>, // opaque "{ts}:{digest}" keyset token (composite)
    pub limit: Option<i64>,
    pub tunnel: Option<String>,
    pub address: Option<String>,
    pub kind: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub system: Option<String>,
    pub max_tokens: Option<u32>,
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/v1/settlements", get(list))
        .route("/v1/settlements/:digest", get(detail))
        .route("/v1/settlements/:digest/transcript", get(transcript))
        .route("/v1/stats/explorer", get(stats))
        .route("/v1/chat", post(chat))
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
            Ok(body) => (
                [(axum::http::header::CONTENT_TYPE, "application/json")],
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

async fn chat(State(s): State<ApiState>, JsonBody(req): JsonBody<ChatRequest>) -> Response {
    let system = req.system.unwrap_or_else(|| "You are a helpful assistant.".into());
    let mut messages = vec![ChatMessage {
        role: "system".into(),
        content: system,
    }];
    messages.extend(req.messages.into_iter().map(|m| ChatMessage {
        role: m.role,
        content: m.content,
    }));

    let mut body = serde_json::json!({
        "model": s.llm_model,
        "messages": messages,
        "stream": true,
    });
    if let Some(max) = req.max_tokens {
        body["options"] = serde_json::json!({ "num_predict": max });
    }

    let url = format!("{}/api/chat", s.llm_base_url.trim_end_matches('/'));
    let mut upstream = s.http.post(&url).json(&body);
    if let Some(key) = &s.llm_api_key {
        upstream = upstream.header(header::AUTHORIZATION, format!("Bearer {key}"));
    }

    match upstream.send().await {
        Ok(resp) => {
            if let Err(e) = resp.error_for_status_ref() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                tracing::error!(error = %e, status = %status, "upstream llm error: {}", text);
                return (StatusCode::BAD_GATEWAY, format!("upstream error: {text}")).into_response();
            }

            let stream = resp.bytes_stream().map(|res| {
                res.map(|bytes: Bytes| axum::body::Bytes::from_owner(bytes.to_vec()))
            });

            (
                [(header::CONTENT_TYPE, "application/x-ndjson")],
                axum::body::Body::from_stream(stream),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to reach upstream llm");
            (StatusCode::BAD_GATEWAY, format!("llm unreachable: {e}")).into_response()
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
            llm_base_url: "http://localhost:11434".into(),
            llm_model: "qwen2.5:3b".into(),
            llm_api_key: None,
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

    async fn mock_llm_server() -> (u16, tokio::task::JoinHandle<()>) {
        use axum::extract::Json;
        use axum::response::IntoResponse;
        use axum::routing::post;
        use axum::Router;

        async fn mock_chat(Json(_): Json<serde_json::Value>) -> impl IntoResponse {
            let body = "{\"message\":{\"role\":\"assistant\",\"content\":\"Hello\"},\"done\":false}\n\
                       {\"message\":{\"role\":\"assistant\",\"content\":\"!\"},\"done\":false}\n\
                       {\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true}\n";
            ([(header::CONTENT_TYPE, "application/x-ndjson")], body)
        }

        let app = Router::new().route("/api/chat", post(mock_chat));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (port, handle)
    }

    #[tokio::test]
    async fn chat_streams_ndjson_from_upstream() {
        let (port, _server) = mock_llm_server().await;
        let mut state = state_with(vec![]);
        state.llm_base_url = format!("http://127.0.0.1:{port}");

        let app = router(state);
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/chat")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        r#"{"messages":[{"role":"user","content":"hi"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get("content-type").unwrap(),
            "application/x-ndjson"
        );
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(text.contains("\"Hello\""));
        assert!(text.contains("\"!\""));
        assert!(text.contains("\"done\":true"));
    }

    #[tokio::test]
    async fn chat_forwards_system_and_num_predict() {
        use axum::extract::State;
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let captured = Arc::new(Mutex::new(None));

        async fn mock_chat(
            State(captured): State<Arc<Mutex<Option<serde_json::Value>>>>,
            Json(body): Json<serde_json::Value>,
        ) -> impl IntoResponse {
            *captured.lock().await = Some(body);
            let stream = "{\"message\":{\"role\":\"assistant\",\"content\":\"ok\"},\"done\":true}\n";
            ([(header::CONTENT_TYPE, "application/x-ndjson")], stream)
        }

        let app = Router::new()
            .route("/api/chat", post(mock_chat))
            .with_state(captured.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let mut state = state_with(vec![]);
        state.llm_base_url = format!("http://127.0.0.1:{port}");

        let res = router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/chat")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        r#"{"messages":[{"role":"user","content":"hi"}],"system":"You are a debater.","max_tokens":80}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::OK);
        let upstream = captured.lock().await.take().expect("upstream received a body");
        assert_eq!(upstream["messages"][0]["role"], "system");
        assert_eq!(upstream["messages"][0]["content"], "You are a debater.");
        assert_eq!(upstream["options"]["num_predict"], 80);
    }
}
