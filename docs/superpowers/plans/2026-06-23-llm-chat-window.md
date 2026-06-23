# LLM Chat Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a game-like floating AI chat window to the arena frontend that streams replies through the explorer backend from a configurable Ollama/AWS LLM endpoint.

**Architecture:** Reuse the existing `games/chat` placeholder module so the window gets minimize/maximize/resize for free. Add a `POST /v1/chat` endpoint to the explorer API service that proxies Ollama-compatible NDJSON streams. The frontend parses the NDJSON stream token-by-token.

**Tech Stack:** React 19 + TypeScript + Tailwind CSS (frontend), Rust + axum + reqwest (backend), `node:test` (frontend tests), `cargo test` (backend tests).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `backend/explorer/src/api.rs` | Add `POST /v1/chat` route + handler, plus unit test. |
| `backend/explorer/src/bin/api.rs` | Read `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` into `ApiState`. |
| `frontend/src/games/chat/useChat.ts` | React hook: chat state, streaming POST, NDJSON parsing. |
| `frontend/src/games/chat/ChatWindow.tsx` | Chat UI: message list, input, send, retry, game-like styling. |
| `frontend/src/games/chat/index.ts` | Register the real chat module in the game registry. |
| `frontend/src/games/index.ts` | Uncomment the chat import so it loads. |

---

## Task 1: Backend — Add LLM config to `ApiState`

**Files:**
- Modify: `backend/explorer/src/api.rs:13-18`
- Modify: `backend/explorer/src/bin/api.rs:26-31`

- [ ] **Step 1: Add LLM fields to `ApiState`**

In `backend/explorer/src/api.rs`, add three fields:

```rust
#[derive(Clone)]
pub struct ApiState {
    pub store: Arc<dyn SettlementStore>,
    pub walrus_aggregator_url: String,
    pub http: reqwest::Client,
    pub llm_base_url: String,
    pub llm_model: String,
    pub llm_api_key: Option<String>,
}
```

- [ ] **Step 2: Read env vars in the API binary**

In `backend/explorer/src/bin/api.rs`, update the `state` construction:

```rust
    let state = ApiState {
        store,
        walrus_aggregator_url: std::env::var("WALRUS_AGGREGATOR_URL")
            .unwrap_or_else(|_| "https://aggregator.walrus-testnet.walrus.space".into()),
        http: reqwest::Client::new(),
        llm_base_url: std::env::var("LLM_BASE_URL")
            .unwrap_or_else(|_| "http://localhost:11434".into()),
        llm_model: std::env::var("LLM_MODEL")
            .unwrap_or_else(|_| "qwen2.5:3b".into()),
        llm_api_key: std::env::var("LLM_API_KEY").ok(),
    };
```

- [ ] **Step 3: Update existing tests that construct `ApiState`**

The `state_with` helper in `backend/explorer/src/api.rs` (around line 128) needs the new fields. Replace it with:

```rust
    fn state_with(rows: Vec<SettlementRow>) -> ApiState {
        let store = InMemorySettlementStore::new();
        for r in rows {
            futures::executor::block_on(store.upsert(r)).unwrap();
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
```

- [ ] **Step 4: Build backend to verify types**

Run:

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat/backend/explorer
cargo check
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat
git add backend/explorer/src/api.rs backend/explorer/src/bin/api.rs
git commit -m "feat(explorer): add llm config to api state"
```

---

## Task 2: Backend — Implement `POST /v1/chat`

**Files:**
- Modify: `backend/explorer/src/api.rs:1-37` (imports + router)
- Modify: `backend/explorer/src/api.rs:108-118` (after `stats` handler, add `chat` handler)

- [ ] **Step 1: Add imports**

At the top of `backend/explorer/src/api.rs`, add to the axum imports:

```rust
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
```

Add `Bytes` import from `bytes` crate (already a transitive dep via axum/reqwest):

```rust
use bytes::Bytes;
```

If `bytes` is not directly in `Cargo.toml`, add it:

```toml
bytes = "1"
```

in `backend/explorer/Cargo.toml`.

- [ ] **Step 2: Add route**

In `pub fn router`, add:

```rust
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
```

- [ ] **Step 3: Add request/response types**

After the `ListParams` struct, add:

```rust
#[derive(serde::Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}
```

- [ ] **Step 4: Implement the `chat` handler**

After `stats`, add:

```rust
async fn chat(State(s): State<ApiState>, Json(req): Json<ChatRequest>) -> Response {
    let mut messages = vec![ChatMessage {
        role: "system".into(),
        content: "You are a helpful assistant.".into(),
    }];
    messages.extend(req.messages.into_iter().map(|m| ChatMessage {
        role: m.role,
        content: m.content,
    }));

    let body = serde_json::json!({
        "model": s.llm_model,
        "messages": messages,
        "stream": true,
    });

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
```

- [ ] **Step 5: Build backend**

Run:

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat/backend/explorer
cargo check
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat
git add backend/explorer/src/api.rs backend/explorer/Cargo.toml
git commit -m "feat(explorer): add /v1/chat proxy endpoint"
```

---

## Task 3: Backend — Test `POST /v1/chat`

**Files:**
- Modify: `backend/explorer/src/api.rs` (test module)

- [ ] **Step 1: Add test helper imports**

Inside the `#[cfg(test)] mod tests` block, add:

```rust
use axum::body::to_bytes;
use std::convert::Infallible;
```

- [ ] **Step 2: Add a mock upstream LLM server helper**

Add inside the test module:

```rust
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
```

- [ ] **Step 3: Add the `/v1/chat` streaming test**

Add inside the test module:

```rust
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
```

- [ ] **Step 4: Run backend tests**

Run:

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat/backend/explorer
cargo test
```

Expected: all tests pass, including the new `chat_streams_ndjson_from_upstream`.

- [ ] **Step 5: Commit**

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat
git add backend/explorer/src/api.rs
git commit -m "test(explorer): /v1/chat streams ndjson"
```

---

## Task 4: Frontend — Create `useChat` hook

**Files:**
- Create: `frontend/src/games/chat/useChat.ts`

- [ ] **Step 1: Implement `useChat.ts`**

Create `frontend/src/games/chat/useChat.ts`:

```ts
import { useCallback, useRef, useState } from "react";
import { resolveBackendUrl } from "@/backend/controlPlane";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface UseChat {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  send: (text: string) => Promise<void>;
  retry: () => void;
}

function ndjsonLines(stream: ReadableStream<Uint8Array>): ReadableStream<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  return stream.pipeThrough(
    new TransformStream<Uint8Array, string>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) controller.enqueue(line);
        }
      },
      flush(controller) {
        if (buffer.trim()) controller.enqueue(buffer);
      },
    }),
  );
}

function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function useChat(): UseChat {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<{ text: string; messages: ChatMessage[] } | null>(null);

  const retry = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    setError(null);
    setMessages(pending.messages);
    void sendMessages(pending.messages);
  }, []);

  const sendMessages = useCallback(async (history: ChatMessage[]) => {
    setIsStreaming(true);
    setError(null);

    const assistantId = generateId();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "" },
    ]);

    try {
      const base = resolveBackendUrl();
      const res = await fetch(`${base}/v1/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "request failed");
        throw new Error(text);
      }

      if (!res.body) {
        throw new Error("no response body");
      }

      const reader = ndjsonLines(res.body).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        let parsed: { message?: { content?: string }; done?: boolean };
        try {
          parsed = JSON.parse(value) as typeof parsed;
        } catch {
          continue;
        }
        const delta = parsed.message?.content ?? "";
        if (delta || parsed.done) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + delta } : m,
            ),
          );
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      pendingRef.current = { text: "", messages: history };
    } finally {
      setIsStreaming(false);
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      const userMsg: ChatMessage = {
        id: generateId(),
        role: "user",
        content: trimmed,
      };
      const nextHistory = [...messages, userMsg];
      pendingRef.current = { text: trimmed, messages: nextHistory };
      setMessages(nextHistory);
      await sendMessages(nextHistory);
    },
    [isStreaming, messages, sendMessages],
  );

  return { messages, isStreaming, error, send, retry };
}
```

- [ ] **Step 2: (No frontend unit test in this iteration)**

`@testing-library/react` and `jsdom` are not project dependencies, so we skip a hook UI test to keep the change minimal. The hook is verified by `tsc --noEmit` and the manual smoke test in Task 8. If the project later adds a React testing library, add a `useChat.test.ts` that mocks `fetch` with a `ReadableStream`.

- [ ] **Step 3: Typecheck frontend**

Run:

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat/frontend
pnpm typecheck
```

Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat
git add frontend/src/games/chat/useChat.ts
git commit -m "feat(chat): add useChat streaming hook"
```

---

## Task 5: Frontend — Create `ChatWindow.tsx`

**Files:**
- Create: `frontend/src/games/chat/ChatWindow.tsx`

- [ ] **Step 1: Implement the component**

Create `frontend/src/games/chat/ChatWindow.tsx`:

```tsx
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, RotateCcw, Send, Sparkles, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChat } from "./useChat";
import type { GameWindowProps } from "../types";

export function ChatWindow(_props: GameWindowProps) {
  const { messages, isStreaming, error, send, retry } = useChat();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || isStreaming) return;
    const text = draft;
    setDraft("");
    await send(text);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-card/50">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Sparkles className="size-3.5 text-primary" />
          AI Chat
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span
            className={`size-1.5 rounded-full ${isStreaming ? "animate-pulse bg-primary" : "bg-success"}`}
          />
          {isStreaming ? "thinking…" : "online"}
        </div>
      </div>

      <div
        ref={listRef}
        className="min-h-0 flex-1 space-y-3 overflow-auto p-3 font-mono text-xs"
      >
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Bot className="size-8 opacity-40" />
            <p>Ask the assistant anything.</p>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex gap-2 ${m.role === "user" ? "flex-row-reverse" : ""}`}
          >
            <div
              className={`grid size-6 shrink-0 place-items-center rounded-full border border-border ${
                m.role === "user" ? "bg-secondary" : "bg-primary/10"
              }`}
            >
              {m.role === "user" ? (
                <User className="size-3" />
              ) : (
                <Bot className="size-3 text-primary" />
              )}
            </div>
            <div
              className={`max-w-[80%] rounded-lg border px-2.5 py-1.5 leading-relaxed ${
                m.role === "user"
                  ? "border-primary/30 bg-primary/10 text-foreground"
                  : "border-border bg-secondary/50 text-foreground/90"
              }`}
            >
              {m.content || (isStreaming ? "…" : "")}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="flex items-center justify-between border-y border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <span className="truncate">{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={retry}
            aria-label="Retry"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        </div>
      )}

      <form
        onSubmit={submit}
        className="flex shrink-0 items-center gap-2 border-t border-border p-2"
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message…"
          className="h-8 font-mono text-xs"
          aria-label="Chat message"
          disabled={isStreaming}
        />
        <Button
          type="submit"
          size="icon-sm"
          disabled={isStreaming || !draft.trim()}
          aria-label="Send message"
        >
          <Send className="size-3.5" />
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run:

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat/frontend
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat
git add frontend/src/games/chat/ChatWindow.tsx
git commit -m "feat(chat): add game-like chat window ui"
```

---

## Task 6: Frontend — Register the Chat Module

**Files:**
- Modify: `frontend/src/games/chat/index.ts`
- Modify: `frontend/src/games/index.ts`

- [ ] **Step 1: Replace placeholder registration**

Replace `frontend/src/games/chat/index.ts` with:

```ts
import { register } from "../registry";
import { ChatWindow } from "./ChatWindow";

register({
  id: "chat",
  name: "AI Chat",
  icon: "🤖",
  image: "/games/chat-app.png",
  Window: ChatWindow,
  defaultSize: { w: 4, h: 5 },
  minSize: { w: 3, h: 3 },
});
```

- [ ] **Step 2: Uncomment chat import**

In `frontend/src/games/index.ts`, change:

```ts
// import "./chat";
```

to:

```ts
import "./chat";
```

- [ ] **Step 3: Typecheck**

Run:

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat/frontend
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat
git add frontend/src/games/chat/index.ts frontend/src/games/index.ts
git commit -m "feat(chat): register ai chat window in game registry"
```

---

## Task 7: Integration — Run Frontend Checks and Build

**Files:** n/a

- [ ] **Step 1: Install frontend dependencies**

Run:

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat/frontend
pnpm install
```

Expected: dependencies up to date.

- [ ] **Step 2: Typecheck**

Run:

```bash
pnpm typecheck
```

Expected: exit 0.

- [ ] **Step 3: Run existing tests**

Run:

```bash
pnpm test
```

Expected: all existing tests pass.

- [ ] **Step 4: Build**

Run:

```bash
pnpm build
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat
git commit --allow-empty -m "chore(chat): verify frontend checks pass"
```

---

## Task 8: Manual Smoke Test

**Files:** n/a

- [ ] **Step 1: Start Ollama with the configured model**

```bash
ollama run qwen2.5:3b
```

Verify Ollama is listening on `http://localhost:11434`.

- [ ] **Step 2: Start the explorer API with LLM env vars**

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat/backend/explorer
LLM_BASE_URL=http://localhost:11434 LLM_MODEL=qwen2.5:3b cargo run --bin api
```

- [ ] **Step 3: Start the frontend dev server**

```bash
cd /Users/maixuantung/Dev/commandoss/dopamint-arena/.worktrees/feat/frontend-chat/frontend
pnpm dev
```

- [ ] **Step 4: Open the UI and add the AI Chat window**

1. Open `http://localhost:5173` (or the printed Vite URL).
2. Click the **+** button or use layout tools to add the **AI Chat** window.
3. Type a message and send.
4. Verify the assistant reply streams in token-by-token.

- [ ] **Step 5: Commit a smoke-test note**

No code change; skip commit.

---

## Self-Review Checklist

- [ ] **Spec coverage:**
  - New AI chat window separate from Community Chat → Task 6.
  - Floating window on desktop floor → Task 6 (registry gives windowing).
  - Backend proxy → Tasks 1–3.
  - Ephemeral history → Task 4 (`useChat` uses local state).
  - Streaming token-by-token → Tasks 2 & 4.
  - Configurable Ollama/AWS → Task 1 env vars.
  - Game-like UI → Task 5.
  - Manual verification → Task 8.

- [ ] **Placeholder scan:** No TBD/TODO/similar placeholders in the plan.

- [ ] **Type consistency:** `ApiState` fields match across `api.rs` and `bin/api.rs`; `messages` shape matches between frontend request and backend types.

## Notes

- The frontend test is intentionally omitted because `@testing-library/react` is not in the project dependencies. The hook is covered by TypeScript and the backend test covers the wire contract.
- If the team later adds a React testing library, add `frontend/src/games/chat/useChat.test.ts` that mocks `fetch` with a `ReadableStream`.
