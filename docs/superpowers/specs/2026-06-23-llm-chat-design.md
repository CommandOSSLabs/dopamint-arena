# LLM Chat Window

## Context

Add a small, game-like AI chat window to the Dopamint Arena frontend. The user sends messages and an LLM replies. The model runs locally via Ollama during development and is repointed to a larger model on AWS after deployment.

## Decisions

- **Scope:** a new AI chat window. The existing hidden mock Community Chat panel (`frontend/src/panels/ChatPanel.tsx`) is left untouched.
- **Purpose:** plain general-purpose chat; no arena/game context awareness.
- **UI placement:** floating window on the desktop floor, like the existing game windows.
- **LLM path:** all traffic goes through the backend for security; no direct browser → Ollama calls.
- **History:** ephemeral, per page load.
- **Response style:** streaming token-by-token.
- **Local model:** Qwen (configurable).

## Architecture

```text
┌─────────────────────────────────────┐
│  frontend/src/games/chat/ChatWindow │
│  frontend/src/games/chat/useChat    │
└──────────────┬──────────────────────┘
               │ POST /v1/chat (NDJSON stream)
               ▼
┌─────────────────────────────────────┐
│  backend/explorer/src/api.rs        │
│  /v1/chat                             │
└──────────────┬──────────────────────┘
               │ proxy
               ▼
        Ollama (local)  or  AWS LLM (deployed)
```

## Frontend

Replace the placeholder `frontend/src/games/chat/index.ts` with a real module.

### Files

- `frontend/src/games/chat/index.ts` — register the module:
  - `id: "chat"`
  - `name: "AI Chat"`
  - icon/image
  - `Window: ChatWindow`
- `frontend/src/games/chat/ChatWindow.tsx` — window content:
  - scrollable message list (user right-aligned, assistant left-aligned)
  - input field + send button
  - streaming indicator
  - retry on failure
  - game-like styling: neon accents, pixel/monospace touches, card/border style matching the arena windows
- `frontend/src/games/chat/useChat.ts` — chat state + streaming fetch:
  - append user message
  - POST `{ model, messages, stream: true }` to `${apiRoot()}/v1/chat`
  - read `ReadableStream` and append chunks to the assistant message
  - ephemeral state only

### API request shape

```ts
POST /v1/chat
Content-Type: application/json

{
  "model": "qwen2.5:3b",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": true
}
```

Response is an Ollama-compatible NDJSON stream. Each line is a JSON object; `message.content` holds the next token and `done: true` marks the end.

## Backend

Add `POST /v1/chat` to the existing `explorer` API service (`backend/explorer/src/api.rs`). The explorer service is already frontend-facing and includes `reqwest` and `axum`.

### Route

```rust
.route("/v1/chat", post(chat))
```

### Handler behavior

1. Parse JSON body `{ model, messages, stream }`.
2. Inject a minimal system message: `"You are a helpful assistant."`.
3. Forward to upstream chat endpoint:
   - `${LLM_BASE_URL}/api/chat` for Ollama compatibility.
   - Add `Authorization` header if `LLM_API_KEY` is set.
   - Preserve `stream: true` so the upstream returns NDJSON.
4. Proxy the upstream NDJSON stream back to the client with `Content-Type: application/x-ndjson`.
5. On upstream failure, return `502 Bad Gateway` with a short message.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `LLM_BASE_URL` | Upstream LLM base URL, e.g. `http://host.docker.internal:11434` |
| `LLM_MODEL` | Model name, e.g. `qwen2.5:3b` |
| `LLM_API_KEY` | Optional API key for AWS/protected endpoints |

### Local dev example

```bash
LLM_BASE_URL=http://localhost:11434
LLM_MODEL=qwen2.5:3b
```

### AWS example

```bash
LLM_BASE_URL=https://your-aws-llm-endpoint
LLM_MODEL=qwen2.5:14b
LLM_API_KEY=...
```

## Streaming & error handling

- Frontend disables the send button while a reply is streaming.
- Show a subtle “…” or pulsing cursor while waiting for the first chunk.
- If the stream fails, keep the partial reply and show a retry button.
- Empty/whitespace messages are not sent.
- If the backend is unreachable, show a friendly offline/error message in the chat window.

## UI styling

Make the window feel native to the arena:

- Use the existing Panel / GameWindow chrome.
- Message bubbles with subtle borders and glow accents.
- User messages on the right, assistant on the left.
- Monospace or semi-monospace typography for messages.
- A small status dot / model name in the header.

## Testing

- **Backend:** add a unit test in `backend/explorer/src/api.rs` that mocks the upstream LLM and verifies `/v1/chat` streams chunks correctly.
- **Frontend:** add a unit test for `useChat` verifying that user messages are appended and assistant content updates as chunks arrive.

## Out of scope

- Persisting chat history.
- Arena/game context awareness.
- Multi-user chat or presence.
- Tool calling or function calling.

## Affected files

- `frontend/src/games/chat/index.ts`
- `frontend/src/games/chat/ChatWindow.tsx` (new)
- `frontend/src/games/chat/useChat.ts` (new)
- `frontend/src/games/index.ts` (uncomment chat import)
- `frontend/src/backend/controlPlane.ts` (reuse `resolveBackendUrl`)
- `backend/explorer/src/api.rs`
- `backend/explorer/src/bin/api.rs` (add env vars to `ApiState`)
