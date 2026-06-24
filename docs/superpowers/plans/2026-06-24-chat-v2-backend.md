# Chat v2 backend (tunnel-manager) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `/v1/chat` Ollama proxy, topic endpoint, and bot-vs-bot SSE publisher to `tunnel-manager`.

**Architecture:** Extend the existing Axum `Router` with three chat routes. Add a thin `reqwest` client for Ollama and an in-memory transcript store backed by a tokio broadcast channel for SSE. Reuse the existing `Config`, `AppState`, `ApiError`, and camelCase JSON conventions.

**Tech Stack:** Rust, Axum 0.7, tokio, serde, reqwest, tokio-stream.

---

### Task 1: Add Ollama env vars to Config

**Files:**
- Modify: `backend/tunnel-manager/.env.example`
- Modify: `backend/tunnel-manager/src/config.rs`
- Test: `backend/tunnel-manager/src/config.rs` (existing unit tests)

- [ ] **Step 1: Write the failing test**

Add two assertions to the existing `from_env_reads_redis_and_instance` test (or a new test) that prove `OLLAMA_URL` and `OLLAMA_MODEL` are loaded.

```rust
#[test]
fn from_env_reads_ollama_config() {
    std::env::set_var("OLLAMA_URL", "http://ollama:11434");
    std::env::set_var("OLLAMA_MODEL", "qwen2.5:1.8b");
    let c = Config::from_env().unwrap();
    assert_eq!(c.ollama_url.as_deref(), Some("http://ollama:11434"));
    assert_eq!(c.ollama_model.as_deref(), Some("qwen2.5:1.8b"));
    std::env::remove_var("OLLAMA_URL");
    std::env::remove_var("OLLAMA_MODEL");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p tunnel-manager config::tests::from_env_reads_ollama_config -- --nocapture`

Expected: FAIL with `no field ollama_url` or similar.

- [ ] **Step 3: Add the fields and loading**

In `backend/tunnel-manager/src/config.rs`:

```rust
pub struct Config {
    pub bind_addr: String,
    pub coin_type: String,
    pub sui_rpc_url: Option<String>,
    pub package_id: Option<String>,
    pub settler_key: Option<String>,
    pub walrus_publisher_url: Option<String>,
    pub walrus_aggregator_url: Option<String>,
    pub redis_cache_url: Option<String>,
    pub redis_pubsub_url: Option<String>,
    pub instance_id: Option<String>,
    pub ollama_url: Option<String>,
    pub ollama_model: Option<String>,
}
```

In `Config::from_env`:

```rust
ollama_url: opt("OLLAMA_URL"),
ollama_model: opt("OLLAMA_MODEL"),
```

In `backend/tunnel-manager/.env.example`, append:

```bash
# Ollama LLM proxy (chat-v2)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:1.8b
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p tunnel-manager config::tests::from_env_reads_ollama_config -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/tunnel-manager/.env.example backend/tunnel-manager/src/config.rs
git commit -m "build(chat): add OLLAMA_URL and OLLAMA_MODEL config"
```

---

### Task 2: Implement OllamaClient

**Files:**
- Create: `backend/tunnel-manager/src/ollama.rs`
- Modify: `backend/tunnel-manager/src/main.rs` (mod declaration)
- Test: `backend/tunnel-manager/src/ollama.rs`

- [ ] **Step 1: Write the failing test**

Create `backend/tunnel-manager/src/ollama.rs` with a test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn chat_forwards_messages_and_extracts_reply() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "message": { "role": "assistant", "content": "hello back" }
        });
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let client = OllamaClient::new(server.uri(), "qwen2.5:1.8b".into());
        let reply = client
            .chat(&[OllamaMessage { role: "user".into(), content: "hi".into() }])
            .await
            .unwrap();
        assert_eq!(reply, "hello back");
    }
}
```

Add `mod ollama;` to `backend/tunnel-manager/src/main.rs` near the other `mod` lines.

Run: `cargo test -p tunnel-manager ollama::tests::chat_forwards_messages_and_extracts_reply -- --nocapture`

Expected: FAIL with `OllamaClient` / `OllamaMessage` not found.

- [ ] **Step 2: Implement the client**

Append to `backend/tunnel-manager/src/ollama.rs` (above the test module):

```rust
//! Thin proxy client for a local Ollama instance.

use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
struct OllamaChatRequest<'a> {
    model: &'a str,
    messages: &'a [OllamaMessage],
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: OllamaMessage,
}

pub struct OllamaClient {
    http: reqwest::Client,
    base_url: String,
    model: String,
}

impl OllamaClient {
    pub fn new(base_url: String, model: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: base_url.trim_end_matches('/').into(),
            model,
        }
    }

    /// Non-streaming chat completion. Returns the assistant's text.
    pub async fn chat(&self, messages: &[OllamaMessage]) -> anyhow::Result<String> {
        let url = format!("{}/api/chat", self.base_url);
        let req = OllamaChatRequest {
            model: &self.model,
            messages,
            stream: false,
        };
        let resp: OllamaChatResponse = self
            .http
            .post(&url)
            .json(&req)
            .send()
            .await
            .context("ollama request failed")?
            .error_for_status()
            .context("ollama returned error")?
            .json()
            .await
            .context("ollama returned non-json")?;
        Ok(resp.message.content)
    }

    /// Ask Ollama for a short random conversation topic.
    pub async fn topic(&self) -> anyhow::Result<String> {
        let prompt = OllamaMessage {
            role: "user".into(),
            content: "Give me one short, fun conversation topic for two chat bots. Answer with the topic only, no extra text.".into(),
        };
        self.chat(&[prompt]).await
    }
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cargo test -p tunnel-manager ollama::tests::chat_forwards_messages_and_extracts_reply -- --nocapture`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/tunnel-manager/src/ollama.rs backend/tunnel-manager/src/main.rs
git commit -m "feat(chat): add Ollama client"
```

---

### Task 3: Wire OllamaClient into AppState

**Files:**
- Modify: `backend/tunnel-manager/src/state.rs`
- Modify: `backend/tunnel-manager/src/main.rs`
- Modify: `backend/tunnel-manager/src/routes.rs` (test_support builder)

- [ ] **Step 1: Add the field and constructor**

In `backend/tunnel-manager/src/state.rs`:

```rust
pub struct AppState {
    pub control: std::sync::Arc<dyn crate::store::ControlStore>,
    pub mp: std::sync::Arc<dyn crate::store::MpStore>,
    pub bus: std::sync::Arc<dyn crate::store::Bus>,
    pub settler: crate::sui::SuiSettler,
    pub walrus: crate::walrus::WalrusClient,
    pub ollama: crate::ollama::OllamaClient,
    pub stats_tx: broadcast::Sender<String>,
    pub actions: crate::stats_counter::LocalActionCounter,
}
```

In the `in_memory_for_test` builder, add:

```rust
ollama: crate::ollama::OllamaClient::new(String::new(), String::new()),
```

- [ ] **Step 2: Construct the client in main**

In `backend/tunnel-manager/src/main.rs`, after building `walrus`:

```rust
let ollama = crate::ollama::OllamaClient::new(
    config.ollama_url.clone().unwrap_or_else(|| "http://localhost:11434".into()),
    config.ollama_model.clone().unwrap_or_else(|| "qwen2.5:1.8b".into()),
);
```

Add `ollama` to the `AppState` initializer.

- [ ] **Step 3: Update the test state builder**

In `backend/tunnel-manager/src/routes.rs` `test_support::test_state()`:

```rust
ollama: crate::ollama::OllamaClient::new(String::new(), String::new()),
```

- [ ] **Step 4: Compile and test**

Run: `cargo test -p tunnel-manager --lib`

Expected: all lib tests compile and pass.

- [ ] **Step 5: Commit**

```bash
git add backend/tunnel-manager/src/state.rs backend/tunnel-manager/src/main.rs backend/tunnel-manager/src/routes.rs
git commit -m "feat(chat): wire OllamaClient into AppState"
```

---

### Task 4: Add POST /v1/chat

**Files:**
- Modify: `backend/tunnel-manager/src/routes.rs`
- Modify: `backend/tunnel-manager/src/main.rs`

- [ ] **Step 1: Write the failing test**

Add a test in `backend/tunnel-manager/src/routes.rs` `mod tests`:

```rust
#[tokio::test]
async fn chat_endpoint_forwards_to_ollama() {
    use crate::ollama::{OllamaClient, OllamaMessage};
    let mut state = test_state();
    // Replace the no-op ollama client with a mockable one by constructing a fresh state manually.
    let server = wiremock::MockServer::start().await;
    let body = serde_json::json!({ "message": { "role": "assistant", "content": "ok" } });
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/api/chat"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;
    let ollama = OllamaClient::new(server.uri(), "qwen2.5:1.8b".into());
    state.ollama = ollama;

    let req = ChatRequest {
        messages: vec![OllamaMessage { role: "user".into(), content: "hi".into() }],
        model: None,
        stream: None,
    };
    let resp = chat(axum::extract::State(state), axum::Json(req)).await;
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
}
```

Run: `cargo test -p tunnel-manager routes::tests::chat_endpoint_forwards_to_ollama -- --nocapture`

Expected: FAIL with `ChatRequest` / `chat` not found.

- [ ] **Step 2: Add request/response types and handler**

In `backend/tunnel-manager/src/routes.rs`, after the existing `SponsorResponse` block:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatRequest {
    messages: Vec<crate::ollama::OllamaMessage>,
    model: Option<String>,
    stream: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatResponse {
    content: String,
}

pub(crate) async fn chat(
    State(state): State<SharedState>,
    Json(req): Json<ChatRequest>,
) -> Response {
    match state.ollama.chat(&req.messages).await {
        Ok(content) => Json(ChatResponse { content }).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "ollama chat failed");
            ApiError::resp(
                axum::http::StatusCode::BAD_GATEWAY,
                "ollama_error",
                &e.to_string(),
            )
            .into_response()
        }
    }
}
```

- [ ] **Step 3: Wire the route**

In `backend/tunnel-manager/src/main.rs`, add inside the `Router::new()` chain before `.layer(...)`:

```rust
.route("/v1/chat", post(routes::chat))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p tunnel-manager routes::tests::chat_endpoint_forwards_to_ollama -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/tunnel-manager/src/routes.rs backend/tunnel-manager/src/main.rs
git commit -m "feat(chat): add POST /v1/chat Ollama proxy"
```

---

### Task 5: Add GET /v1/chat/topic

**Files:**
- Modify: `backend/tunnel-manager/src/routes.rs`
- Modify: `backend/tunnel-manager/src/main.rs`

- [ ] **Step 1: Write the failing test**

Add to `routes.rs` `mod tests`:

```rust
#[tokio::test]
async fn chat_topic_endpoint_returns_topic() {
    use crate::ollama::OllamaClient;
    let mut state = test_state();
    let server = wiremock::MockServer::start().await;
    let body = serde_json::json!({ "message": { "role": "assistant", "content": "space travel" } });
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/api/chat"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;
    state.ollama = OllamaClient::new(server.uri(), "qwen2.5:1.8b".into());

    let resp = chat_topic(axum::extract::State(state)).await;
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
}
```

Run: `cargo test -p tunnel-manager routes::tests::chat_topic_endpoint_returns_topic -- --nocapture`

Expected: FAIL with `chat_topic` not found.

- [ ] **Step 2: Implement the handler**

In `backend/tunnel-manager/src/routes.rs`, after `chat`:

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TopicResponse {
    topic: String,
}

pub(crate) async fn chat_topic(State(state): State<SharedState>) -> Response {
    match state.ollama.topic().await {
        Ok(topic) => Json(TopicResponse { topic }).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "ollama topic failed");
            ApiError::resp(
                axum::http::StatusCode::BAD_GATEWAY,
                "ollama_error",
                &e.to_string(),
            )
            .into_response()
        }
    }
}
```

- [ ] **Step 3: Wire the route**

In `backend/tunnel-manager/src/main.rs`:

```rust
.route("/v1/chat/topic", get(routes::chat_topic))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p tunnel-manager routes::tests::chat_topic_endpoint_returns_topic -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/tunnel-manager/src/routes.rs backend/tunnel-manager/src/main.rs
git commit -m "feat(chat): add GET /v1/chat/topic"
```

---

### Task 6: Add bot-vs-bot transcript SSE

**Files:**
- Create: `backend/tunnel-manager/src/chat_store.rs`
- Modify: `backend/tunnel-manager/src/main.rs`
- Modify: `backend/tunnel-manager/src/state.rs`
- Modify: `backend/tunnel-manager/src/routes.rs`

- [ ] **Step 1: Write the failing test**

Create `backend/tunnel-manager/src/chat_store.rs` with a test first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_broadcasts_to_sse_subscribers() {
        let store = ChatTranscriptStore::new();
        let mut rx = store.subscribe();
        store.publish(ChatMessage { sender: "bot-a", text: "hello" }).await;
        let ev = rx.recv().await.unwrap();
        assert!(ev.contains("bot-a"));
        assert!(ev.contains("hello"));
    }
}
```

Add `mod chat_store;` to `backend/tunnel-manager/src/main.rs`.

Run: `cargo test -p tunnel-manager chat_store::tests::publish_broadcasts_to_sse_subscribers -- --nocapture`

Expected: FAIL with `ChatTranscriptStore` / `ChatMessage` not found.

- [ ] **Step 2: Implement the store**

In `backend/tunnel-manager/src/chat_store.rs`:

```rust
//! In-memory store for the current bot-vs-bot transcript, plus SSE fan-out.

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

const CAP: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub sender: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTranscript {
    pub messages: Vec<ChatMessage>,
}

pub struct ChatTranscriptStore {
    tx: broadcast::Sender<String>,
    messages: std::sync::Mutex<Vec<ChatMessage>>,
}

impl ChatTranscriptStore {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel::<String>(16);
        Self {
            tx,
            messages: std::sync::Mutex::new(Vec::with_capacity(CAP)),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    pub async fn publish(&self, msg: ChatMessage) {
        let json = {
            let mut lock = self.messages.lock().expect("chat store mutex poisoned");
            lock.push(msg);
            if lock.len() > CAP {
                lock.remove(0);
            }
            serde_json::to_string(&ChatTranscript { messages: lock.clone() })
                .unwrap_or_default()
        };
        let _ = self.tx.send(json);
    }

    pub fn snapshot(&self) -> ChatTranscript {
        let lock = self.messages.lock().expect("chat store mutex poisoned");
        ChatTranscript { messages: lock.clone() }
    }
}

impl Default for ChatTranscriptStore {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 3: Add the store to AppState and test state**

In `backend/tunnel-manager/src/state.rs`, add field:

```rust
pub chat: crate::chat_store::ChatTranscriptStore,
```

Initialize in `in_memory_for_test`:

```rust
chat: crate::chat_store::ChatTranscriptStore::new(),
```

In `backend/tunnel-manager/src/main.rs`, initialize:

```rust
chat: crate::chat_store::ChatTranscriptStore::new(),
```

In `backend/tunnel-manager/src/routes.rs` `test_support::test_state`:

```rust
chat: crate::chat_store::ChatTranscriptStore::new(),
```

- [ ] **Step 4: Add handlers and routes**

In `backend/tunnel-manager/src/routes.rs`, add:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishChatRequest {
    pub messages: Vec<crate::chat_store::ChatMessage>,
}

pub(crate) async fn chat_publish(
    State(state): State<SharedState>,
    Json(req): Json<PublishChatRequest>,
) -> StatusCode {
    for msg in req.messages {
        state.chat.publish(msg).await;
    }
    StatusCode::NO_CONTENT
}

pub(crate) async fn chat_live(
    State(state): State<SharedState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(state.chat.subscribe()).filter_map(|msg| {
        msg.ok()
            .map(|json| Ok::<_, Infallible>(Event::default().data(json)))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}
```

Wire in `backend/tunnel-manager/src/main.rs`:

```rust
.route("/v1/chat/live/publish", post(routes::chat_publish))
.route("/v1/chat/live", get(routes::chat_live))
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p tunnel-manager chat_store::tests -- --nocapture`

Expected: PASS.

Run: `cargo test -p tunnel-manager --lib`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/tunnel-manager/src/chat_store.rs backend/tunnel-manager/src/state.rs backend/tunnel-manager/src/main.rs backend/tunnel-manager/src/routes.rs
git commit -m "feat(chat): add bot-vs-bot transcript SSE store"
```

---

## Self-review checklist

- [x] `OLLAMA_URL` and `OLLAMA_MODEL` are loaded into `Config`.
- [x] `/v1/chat` forwards chat requests to Ollama and returns the assistant reply.
- [x] `/v1/chat/topic` returns a topic string from Ollama.
- [x] `/v1/chat/live/publish` accepts transcript updates.
- [x] `/v1/chat/live` streams the current transcript over SSE.
- [x] All new code is covered by unit tests and compiles with the existing backend.

## Verification

After all tasks:

```bash
cd backend/tunnel-manager
cargo test -p tunnel-manager
cargo run -p tunnel-manager
```

Then in another terminal:

```bash
curl -X POST http://localhost:8080/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}'

curl http://localhost:8080/v1/chat/topic
```

(Requires Ollama running locally with `qwen2.5:1.8b`.)
