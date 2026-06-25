# Chat v2 design

> **Type:** design  
> **Scope:** A real tunnel-backed chat game in Dopamint Arena with two modes: user chats with a bot, and a continuous bot-vs-bot spectator loop.  
> **Date:** 2026-06-24  
> **Status:** approved

## Goal

Add a playable **Chat** window to the arena desktop. Every chat message is a signed move in a two-party Sui tunnel staked with DOPAMINT. The bot is a headless backend agent that replies through a local Ollama LLM.

## Decisions already made

| Topic           | Decision                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| Bot location    | Headless backend agent (genuine two-party tunnel, not browser self-play).                                           |
| Bot-vs-bot mode | Server-side continuous loop; frontend is a spectator.                                                               |
| Bot funding     | Reuse the operator wallet derived from `SUI_SETTLER_KEY`; top up DOPAMINT via the existing `dopamint::mint` faucet. |
| Stake           | 1 DOPAMINT per seat, no tips, refunded on close. Matches the battleship PvP stake.                                  |
| LLM             | Local: `qwen2.5:1.8b`. Production: override via `OLLAMA_MODEL`.                                                     |
| Ollama proxy    | New `/v1/chat` endpoint in `tunnel-manager` forwards to the local Ollama `/api/chat`.                               |
| Agent language  | TypeScript package `backend/chat-agent/` reusing `sui-tunnel-ts`.                                                   |
| Frontend shape  | New catalog game module `frontend/src/games/chat/` with two tabs: _Chat with Bot_ and _Bot vs Bot_.                 |

## Architecture

```text
┌─────────────────┐      wss /v1/mp      ┌─────────────────────────────┐
│  Frontend Chat  │ ◄──────────────────► │   tunnel-manager (Rust)     │
│  window (seat A)│   co-signed moves    │  - /v1/mp relay             │
└─────────────────┘                      │  - /v1/chat Ollama proxy    │
         │                               │  - /v1/chat/topic           │
         │                               │  - /v1/chat/live SSE        │
         │                               └─────────────────────────────┘
         │                                           ▲
         │                                           │ http /v1/chat
┌─────────────────┐      wss /v1/mp      ┌──────────┴───────────────────┐
│  Chat agent     │ ◄──────────────────► │        Ollama (local)        │
│  (seat B pool)  │   co-signed moves    │    qwen2.5:1.8b / qwen2.5:7b │
└─────────────────┘                      └──────────────────────────────┘
         │
         │ on-chain open/fund/close
         ▼
┌─────────────────┐
│   Sui testnet   │
│  tunnel + DOPA  │
└─────────────────┘
```

### Mode 1 — user chats with bot

1. The user opens the **Chat** game window and clicks _Chat with Bot_.
2. The browser mints a fresh ephemeral ed25519 key, connects to `/v1/mp`, and calls `queue.join("chat")`.
3. A chat-agent instance is also connected to `/v1/mp` and joins the same queue.
4. The relay pairs them. Both parties exchange wallet-attested ephemeral pubkeys via `party.hello`.
5. Each seat deposits **1 DOPAMINT** to activate the tunnel:
   - User seat: uses the existing frontend auto-faucet + `depositStakeStaked` helpers.
   - Bot seat: the agent ensures its operator wallet has DOPAMINT and deposits.
6. The user types a message. The frontend signs it as a `ChatMove { kind: "msg", text }` and proposes it through `DistributedTunnel`.
7. The agent receives the move, calls `/v1/chat` to get an Ollama reply, and proposes the reply as its own signed `ChatMove`.
8. When the user closes the window, both parties build a cooperative settlement, exchange halves over the relay, and the backend submits `close_cooperative_with_root` via `/v1/tunnels/:id/settle`.

### Mode 2 — continuous bot-vs-bot

1. Inside the chat-agent, a dedicated pair of agents continuously loops:
   - Call `/v1/chat/topic` to get a random conversation topic.
   - Open a new tunnel, deposit 1 DOPAMINT per seat.
   - Exchange 20 signed chat moves over the tunnel (each reply comes from Ollama).
   - Build a cooperative settlement and close the tunnel.
   - Start the next loop immediately.
2. The agent publishes each bot-vs-bot move to tunnel-manager via `POST /v1/chat/live/publish` (internal control-plane endpoint).
3. The frontend's _Bot vs Bot_ tab opens an SSE stream to `/v1/chat/live` and renders the active conversation.

## Protocol

Reuse the existing `ChatProtocol` in `sui-tunnel-ts/src/protocol/chat.ts` unchanged.

- State is a fixed-size rolling transcript digest; messages never grow the signed state.
- `isTerminal()` is `false`, so tunnels are closed cooperatively.
- No tips; balances stay at the initial 1 DOPAMINT per seat for the whole session.

## Backend changes

### tunnel-manager

- Add `OLLAMA_URL` and `OLLAMA_MODEL` to `backend/tunnel-manager/.env.example` and `Config`.
- Add `src/ollama.rs` with a thin `reqwest` client.
- Add routes in `src/main.rs`:
  - `POST /v1/chat` → forward `{ model, messages, stream }` to Ollama `/api/chat`.
  - `GET /v1/chat/topic` → return a short random topic string from Ollama.
  - `POST /v1/chat/live/publish` → internal endpoint for the chat-agent to push the current bot-vs-bot transcript.
  - `GET /v1/chat/live` → SSE feed of the current bot-vs-bot transcript.
- Reuse global `CorsLayer::permissive()` and `ApiError` envelopes.

### backend/chat-agent/ (new package)

- Node + tsx package with its own `package.json` and `.env.example`.
- Depends on `sui-tunnel-ts` via relative path.
- Entry `src/index.ts` runs two loops:
  - `UserBotPool`: maintain `CHAT_BOT_POOL_SIZE` concurrent matches against users.
  - `BotVsBotLoop`: one continuous pair.
- `src/mpClient.ts`: raw WebSocket client for `/v1/mp` (challenge/connect, `queue.join`, `party.hello`, relay frames). The agent cannot use the frontend's `MpClient` because that lives in the React frontend.
- `src/agent.ts`: one agent = one operator wallet + one ephemeral keypair per match. Handles matchmaking, open/deposit/close, and `DistributedTunnel` moves.
- `src/ollama.ts`: client for `/v1/chat` and `/v1/chat/topic`.
- `src/funding.ts`: ensure operator DOPAMINT balance via `dopamint::mint`, build and sign deposit txs.
- `src/botVsBotStore.ts`: in-memory store of the current loop; publishes to `/v1/chat/live/publish`.
- `src/mpClient.ts`: raw `/v1/mp` WebSocket client.

Env example:

```bash
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
BACKEND_URL=http://localhost:8080
TUNNEL_PACKAGE_ID=0x...
DOPAMINT_PACKAGE_ID=0x...
DOPAMINT_FAUCET_ID=0x...
DOPAMINT_COIN_TYPE=0x...::dopamint::DOPAMINT
OPERATOR_KEY=<same base64 ed25519 secret as SUI_SETTLER_KEY>
CHAT_STAKE_WHOLE_TOKENS=1
CHAT_BOT_POOL_SIZE=3
CHAT_BOT_VS_BOT_ENABLED=true
```

## Frontend changes

- Replace `frontend/src/games/chat/index.ts` placeholder with a real catalog game registration.
- Add `frontend/src/games/chat/ChatWindow.tsx` with two tabs.
- Add `frontend/src/games/chat/useChatSession.ts`:
  - `DistributedTunnel` integration for user-vs-bot.
  - Matchmaking via `MpClient.quickMatch("chat")`.
  - Funding via existing `openSharedTunnelStaked` / `depositStakeStaked`.
  - Cooperative close on teardown.
- Add `frontend/src/games/chat/components/ChatThread.tsx` and `BotVsBotView.tsx`.
- Remove or leave unused the old `frontend/src/panels/ChatPanel.tsx` and `useMockChat.ts` (no visible duplicate chat remains because `Desktop.tsx` already sets `SHOW_CHAT = false`).

## Files touched

```text
backend/tunnel-manager/.env.example
backend/tunnel-manager/src/config.rs
backend/tunnel-manager/src/state.rs
backend/tunnel-manager/src/main.rs
backend/tunnel-manager/src/routes.rs
backend/tunnel-manager/src/ollama.rs          (new)

backend/chat-agent/package.json               (new)
backend/chat-agent/.env.example               (new)
backend/chat-agent/tsconfig.json              (new)
backend/chat-agent/src/index.ts               (new)
backend/chat-agent/src/agent.ts               (new)
backend/chat-agent/src/ollama.ts              (new)
backend/chat-agent/src/funding.ts             (new)
backend/chat-agent/src/botVsBotStore.ts       (new)
backend/chat-agent/src/mpClient.ts            (new)

frontend/src/games/chat/index.ts              (replace placeholder)
frontend/src/games/chat/ChatWindow.tsx        (new)
frontend/src/games/chat/useChatSession.ts     (new)
frontend/src/games/chat/components/*.tsx      (new)
frontend/src/games/index.ts                   (add import if needed; placeholder already imported)
frontend/src/panels/ChatPanel.tsx             (remove or leave unused)
frontend/src/lib/useMockChat.ts               (remove or leave unused)
```

## Local setup

1. Pull the local model: `ollama pull qwen2.5:1.8b`
2. Start Ollama: `ollama serve`
3. Start tunnel-manager: `cargo run -p tunnel-manager`
4. Start the chat-agent: `cd backend/chat-agent && node --import tsx src/index.ts`
5. Start the frontend: `cd frontend && pnpm dev`
6. Connect a Google wallet in the UI; DOPAMINT auto-faucets on login.

## Testing

- `cargo test -p tunnel-manager` (Ollama client + route wiring).
- `cd backend/chat-agent && pnpm test` (protocol + agent unit tests).
- `cd frontend && pnpm typecheck && pnpm build`.
- Manual e2e: open Chat → Chat with Bot, type a message, verify the bot replies and the tunnel closes when the window closes.
- Manual spectator: open Chat → Bot vs Bot and confirm messages stream in.

## Open questions / follow-ups

- Wallet↔ephemeral binding server-side is a known v1 limitation; the frontend continues to verify the on-chain seat before depositing.
- Bot-vs-bot transcript persistence is in-memory only for v1; a restart resets the loop.
- Rate-limiting Ollama cost is out of scope for v1.
