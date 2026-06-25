# Chat v2 frontend implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a catalog game window for chat with two tabs: a staked user-vs-bot PvP chat over a tunnel, and a bot-vs-bot spectator feed.

**Architecture:** A `useChatSession` hook reuses the existing PvP relay, DOPAMINT stake helpers, and `DistributedTunnel` with the `ChatProtocol`. Because `ChatState` only stores a rolling transcript digest, the hook wraps the engine transport to decode incoming move frames and render the opponent's text. A lightweight spectator hook subscribes to the backend SSE feed. UI is a shadcn Tabs window with `ChatThread` and a spectator list.

**Tech Stack:** React 19, Vite, shadcn/ui, `@mysten/dapp-kit`, `sui-tunnel-ts`, TypeScript, `node:test` via `tsx`.

---

### Task 1: Chat session core (frame interceptor)

**Files:**

- Create: `frontend/src/games/chat/session-core.ts`
- Create: `frontend/src/games/chat/session-core.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/chat/session-core.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeFrame,
  identityMoveCodec,
} from "sui-tunnel-ts/core/distributedFrame";
import { interceptChatFrames, type ChatLine } from "./session-core.ts";
import type { ChatMove } from "sui-tunnel-ts/protocol/chat";
import type { Transport } from "sui-tunnel-ts/core/distributedTunnel";

test("interceptChatFrames extracts opponent text and passes frames through", () => {
  const received: Uint8Array[] = [];
  const moves: { by: "A" | "B"; text: string }[] = [];

  const fakeTransport: Transport = {
    send: (bytes) => received.push(bytes),
    onFrame: () => {},
  };

  const wrapped = interceptChatFrames(fakeTransport, (m) => moves.push(m));

  const move: ChatMove = { kind: "msg", text: "hello bot" };
  const frame = {
    kind: "move" as const,
    nonce: 1n,
    by: "B" as const,
    move,
    timestamp: 0n,
    stateHash: new Uint8Array(32),
    partyABalance: 1_000_000_000n,
    partyBBalance: 1_000_000_000n,
    sigProposer: new Uint8Array(64),
  };
  const bytes = encodeFrame(frame, identityMoveCodec as never);

  let callbackBytes: Uint8Array | undefined;
  wrapped.onFrame((b) => {
    callbackBytes = b;
  });
  fakeTransport.onFrame(bytes);

  assert.equal(moves.length, 1);
  assert.equal(moves[0].by, "B");
  assert.equal(moves[0].text, "hello bot");
  assert.ok(callbackBytes);
});
```

Run:

```bash
cd frontend && node --import tsx --test src/games/chat/session-core.test.ts
```

Expected: FAIL with `interceptChatFrames` not found.

- [ ] **Step 2: Implement the interceptor**

Create `frontend/src/games/chat/session-core.ts`:

```ts
import {
  decodeFrame,
  identityMoveCodec,
} from "sui-tunnel-ts/core/distributedFrame";
import type { Transport } from "sui-tunnel-ts/core/distributedTunnel";
import type { ChatMove } from "sui-tunnel-ts/protocol/chat";

export interface ChatLine {
  id: string;
  from: "me" | "them";
  text: string;
}

export interface FramedChatMove {
  by: "A" | "B";
  text: string;
}

/** Wrap a PvP transport so incoming MOVE frames are decoded and the chat text is
 *  surfaced to the UI. ACK frames and the original callback are left untouched. */
export function interceptChatFrames(
  transport: Transport,
  onMove: (m: FramedChatMove) => void,
): Transport {
  return {
    send: (bytes) => transport.send(bytes),
    onFrame: (cb) => {
      transport.onFrame((bytes) => {
        try {
          const frame = decodeFrame<ChatMove>(
            bytes,
            identityMoveCodec as never,
          );
          if (frame.kind === "move" && frame.move.kind === "msg") {
            onMove({ by: frame.by, text: frame.move.text });
          }
        } catch {
          // malformed or non-chat frame; pass through silently
        }
        cb(bytes);
      });
    },
  };
}

export function otherParty(role: "A" | "B"): "A" | "B" {
  return role === "A" ? "B" : "A";
}

/** Which seat proposes at this nonce (A: 0→1, B: 1→2, …). */
export function turnAt(nonce: bigint): "A" | "B" {
  return nonce % 2n === 0n ? "A" : "B";
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run:

```bash
cd frontend && node --import tsx --test src/games/chat/session-core.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/chat/session-core.ts frontend/src/games/chat/session-core.test.ts
git commit -m "feat(chat): add chat frame interceptor"
```

---

### Task 2: Chat backend client

**Files:**

- Create: `frontend/src/backend/chat.ts`
- Create: `frontend/src/backend/chat.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/backend/chat.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { resolveChatLiveUrl } from "./chat.ts";

test("resolveChatLiveUrl builds SSE endpoint from backend base", () => {
  assert.equal(
    resolveChatLiveUrl("http://localhost:8080"),
    "http://localhost:8080/v1/chat/live",
  );
  assert.equal(
    resolveChatLiveUrl("http://localhost:8080/"),
    "http://localhost:8080/v1/chat/live",
  );
});
```

Run:

```bash
cd frontend && node --import tsx --test src/backend/chat.test.ts
```

Expected: FAIL with `resolveChatLiveUrl` not found.

- [ ] **Step 2: Implement the client**

Create `frontend/src/backend/chat.ts`:

```ts
import { resolveBackendUrl } from "./controlPlane";

export interface ChatTranscriptMessage {
  sender: string;
  text: string;
}

export interface ChatTranscriptSnapshot {
  messages: ChatTranscriptMessage[];
}

export interface ChatTopicResponse {
  topic: string;
}

export function resolveChatLiveUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/v1/chat/live";
}

export function resolveChatTopicUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/v1/chat/topic";
}

/** Subscribe to the bot-vs-bot transcript SSE feed. Returns an unsubscribe function. */
export function subscribeChatLive(
  baseUrl: string,
  onSnapshot: (snapshot: ChatTranscriptSnapshot) => void,
): () => void {
  const url = resolveChatLiveUrl(baseUrl);
  const source = new EventSource(url);
  source.onmessage = (ev) => {
    try {
      onSnapshot(JSON.parse(ev.data) as ChatTranscriptSnapshot);
    } catch {
      // ignore malformed frames
    }
  };
  return () => source.close();
}

/** Fetch a fresh spectator topic (best-effort; the SSE already includes the topic). */
export async function fetchChatTopic(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(resolveChatTopicUrl(baseUrl));
    if (!res.ok) return null;
    const data = (await res.json()) as ChatTopicResponse;
    return data.topic;
  } catch {
    return null;
  }
}

/** Browser singleton base URL. */
export function resolveChatBackendUrl(): string {
  return resolveBackendUrl();
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run:

```bash
cd frontend && node --import tsx --test src/backend/chat.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/backend/chat.ts frontend/src/backend/chat.test.ts
git commit -m "feat(chat): add chat backend client"
```

---

### Task 3: useChatSession hook

**Files:**

- Create: `frontend/src/games/chat/useChatSession.ts`
- Create: `frontend/src/games/chat/useChatSession.test.ts`
- Modify: `frontend/src/lib/windowSessions.ts` (no change needed; hook registers a disposer)

- [ ] **Step 1: Write the failing test for pure helpers**

Create `frontend/src/games/chat/useChatSession.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { turnAt, otherParty } from "./session-core.ts";

test("turnAt alternates from nonce 0", () => {
  assert.equal(turnAt(0n), "A");
  assert.equal(turnAt(1n), "B");
  assert.equal(turnAt(2n), "A");
});

test("otherParty swaps A/B", () => {
  assert.equal(otherParty("A"), "B");
  assert.equal(otherParty("B"), "A");
});
```

Run:

```bash
cd frontend && node --import tsx --test src/games/chat/useChatSession.test.ts
```

Expected: PASS (uses already-implemented helpers). This task's real work is the hook.

- [ ] **Step 2: Implement useChatSession**

Create `frontend/src/games/chat/useChatSession.ts`:

```ts
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { toHex, fromHex } from "sui-tunnel-ts/core/bytes";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import {
  ChatProtocol,
  type ChatState,
  type ChatMove,
} from "sui-tunnel-ts/protocol/chat";
import {
  MpClient,
  resolveMpWsUrl,
  type MatchInfo,
  type PvpChannel,
} from "@/pvp/mpClient";
import {
  openSharedTunnelStaked,
  depositStakeStaked,
} from "@/onchain/stakeTunnel";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { DOPAMINT_COIN_TYPE, isDopamintConfigured } from "@/onchain/dopamint";
import { settleViaBackend } from "@/backend/settle";
import { closeCooperativeWithRoot, readCreatedAt } from "@/onchain/tunnelTx";
import { coSignedToSettleRequest } from "@/backend/settleRequest";
import { registerWindowDisposer } from "@/lib/windowSessions";
import {
  interceptChatFrames,
  otherParty,
  turnAt,
  type ChatLine,
} from "./session-core";

export type ChatStatus =
  | "idle"
  | "matching"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface ChatSessionView {
  status: ChatStatus;
  role: "A" | "B" | null;
  messages: ChatLine[];
  canSend: boolean;
  queuedText: string | null;
  error: string | null;
  findMatch: () => void;
  send: (text: string) => void;
  endChat: () => void;
  reset: () => void;
}

const CHAT_STAKE = 1_000_000_000n; // 1 DOPAMINT, 9 decimals
const GAME_KEY = "chat";

interface ChatDeps {
  account: { address: string } | null;
  client: unknown;
  signExec: (tx: never) => Promise<{ digest: string }>;
  sponsoredSignExec: (tx: never) => Promise<{ digest: string }>;
  selectStakeCoin: (min: bigint) => Promise<string>;
  prepareStake: (min: bigint) => Promise<string>;
  ensureStakeBalance: (min: bigint) => Promise<void>;
}

interface Snapshot {
  status: ChatStatus;
  role: "A" | "B" | null;
  messages: ChatLine[];
  canSend: boolean;
  queuedText: string | null;
  error: string | null;
}

function makeInbox(channel: PvpChannel) {
  const buf = new Map<string, unknown>();
  const waiters = new Map<string, (m: unknown) => void>();
  channel.onPeer((m) => {
    const w = waiters.get(m.t);
    if (w) {
      waiters.delete(m.t);
      w(m);
    } else {
      buf.set(m.t, m);
    }
  });
  return <T = unknown>(t: string): Promise<T> =>
    new Promise((res) => {
      const b = buf.get(t);
      if (b) {
        buf.delete(t);
        res(b as T);
      } else {
        waiters.set(t, res as (m: unknown) => void);
      }
    });
}

class ChatSession {
  private deps: ChatDeps | null = null;
  private status: ChatStatus = "idle";
  private role: "A" | "B" | null = null;
  private messages: ChatLine[] = [];
  private error: string | null = null;
  private queuedText: string | null = null;

  private mp: MpClient | null = null;
  private channel: PvpChannel | null = null;
  private tunnel: DistributedTunnel<ChatState, ChatMove> | null = null;
  private transcript: Transcript | null = null;
  private createdAt = 0n;
  private closed = false;

  private listeners = new Set<() => void>();
  private snap: Snapshot = {
    status: "idle",
    role: null,
    messages: [],
    canSend: false,
    queuedText: null,
    error: null,
  };

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): Snapshot => this.snap;

  private emit() {
    const canSend =
      this.status === "playing" &&
      this.tunnel !== null &&
      this.role !== null &&
      turnAt(this.tunnel.nonce) === this.role &&
      this.queuedText === null;

    this.snap = {
      status: this.status,
      role: this.role,
      messages: this.messages.slice(),
      canSend,
      queuedText: this.queuedText,
      error: this.error,
    };
    for (const l of this.listeners) l();
  }

  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }

  setDeps(deps: ChatDeps) {
    this.deps = deps;
  }

  findMatch = () => {
    const deps = this.deps;
    if (!deps?.account) {
      this.error = "connect a wallet first";
      this.status = "error";
      this.emit();
      return;
    }
    const wallet = deps.account.address;

    void (async () => {
      try {
        this.reset(false);
        this.error = null;
        this.status = "matching";
        this.emit();

        const ephemeral = generateKeyPair();
        const mp = new MpClient(resolveMpWsUrl(""), wallet, ephemeral);
        this.mp = mp;
        await mp.connect();

        const match = await mp.quickMatch(GAME_KEY);
        this.role = match.role;
        this.emit();

        const channel = mp.channel(match.matchId);
        this.channel = channel;
        const waitPeer = makeInbox(channel);

        channel.sendPeer({
          t: "hello",
          ephemeralPubkey: toHex(ephemeral.publicKey),
        });
        const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
        const oppPub = fromHex(hello.ephemeralPubkey);

        this.status = "funding";
        this.emit();

        const stake = {
          sponsoredSignExec: deps.sponsoredSignExec as never,
          walletSignExec: deps.signExec as never,
          prepareStake: deps.prepareStake,
          selectStakeCoin: deps.selectStakeCoin,
          ensureStakeBalance: deps.ensureStakeBalance,
        };
        const reads = deps.client as unknown as Parameters<
          typeof openSharedTunnelStaked
        >[0]["reads"];

        let tunnelId: string;
        if (match.role === "A") {
          tunnelId = await openSharedTunnelStaked({
            reads,
            partyA: { address: wallet, publicKey: ephemeral.publicKey },
            partyB: { address: match.opponentWallet, publicKey: oppPub },
            amount: CHAT_STAKE,
            label: GAME_KEY,
            ...stake,
          });
          mp.announceTunnel(match.matchId, tunnelId);
          channel.sendPeer({ t: "opened", tunnelId });
        } else {
          const opened = await waitPeer<{ tunnelId: string }>("opened");
          tunnelId = opened.tunnelId;
          await depositStakeStaked({
            tunnelId,
            amount: CHAT_STAKE,
            label: GAME_KEY,
            ...stake,
          });
        }

        this.createdAt = await readCreatedAt(reads, tunnelId);

        const backend = defaultBackend();
        const interceptedTransport = interceptChatFrames(
          channel.transport,
          (m) => {
            if (m.by !== this.role) {
              this.messages.push({
                id: `${Date.now()}-${m.by}`,
                from: "them",
                text: m.text,
              });
              this.emit();
            }
          },
        );

        const tunnel = new DistributedTunnel<ChatState, ChatMove>(
          new ChatProtocol(),
          {
            tunnelId,
            self: makeEndpoint(backend, wallet, ephemeral, true),
            opponent: makeEndpoint(
              backend,
              match.opponentWallet,
              { publicKey: oppPub, scheme: ephemeral.scheme },
              false,
            ),
            selfParty: match.role,
          },
          interceptedTransport,
          { a: CHAT_STAKE, b: CHAT_STAKE },
        );
        this.tunnel = tunnel;

        const transcript = new Transcript(tunnelId);
        this.transcript = transcript;
        tunnel.onConfirmed = (u) => {
          transcript.append(u);
          this.maybeSendQueued();
          this.emit();
        };

        this.installPeerHandler(match, tunnel, channel);

        this.status = "playing";
        this.emit();
      } catch (e) {
        this.fail(e);
      }
    })();
  };

  private installPeerHandler(
    match: MatchInfo,
    tunnel: DistributedTunnel<ChatState, ChatMove>,
    channel: PvpChannel,
  ) {
    channel.onPeer(async (msg) => {
      if (msg.t === "settle") {
        if (this.closed) return;
        try {
          const sig = fromHex(String(msg.sig));
          const root = fromHex(String(msg.root));
          const half = tunnel.buildSettlementHalfWithRoot(
            this.createdAt,
            root,
            0n,
          );
          if (toHex(half.settlement.transcriptRoot) !== toHex(root)) {
            throw new Error("settlement root mismatch");
          }
          const coSigned = tunnel.combineSettlementWithRoot(
            half.settlement,
            half.sigSelf,
            sig,
          );
          this.closed = true;
          this.status = "settling";
          this.emit();
          if (this.role === "A") {
            await this.submitClose(tunnel.tunnelId, coSigned, transcript);
          }
          this.status = "settled";
          this.emit();
        } catch (e) {
          this.fail(e);
        }
      } else if (msg.t === "closed") {
        this.status = "settled";
        this.emit();
      }
    });
  }

  send = (text: string) => {
    const tunnel = this.tunnel;
    const role = this.role;
    if (!tunnel || !role || this.status !== "playing") return;
    const trimmed = text.trim();
    if (!trimmed) return;

    if (turnAt(tunnel.nonce) !== role) {
      this.queuedText = trimmed;
      this.emit();
      return;
    }

    this.proposeText(trimmed);
  };

  private proposeText(text: string) {
    const tunnel = this.tunnel;
    const role = this.role;
    if (!tunnel || !role) return;
    try {
      tunnel.propose({ kind: "msg", text }, BigInt(Date.now()));
      this.messages.push({ id: `${Date.now()}-me`, from: "me", text });
      this.queuedText = null;
      this.emit();
    } catch (e) {
      this.fail(e);
    }
  }

  private maybeSendQueued() {
    if (
      this.queuedText &&
      this.tunnel &&
      this.role &&
      turnAt(this.tunnel.nonce) === this.role
    ) {
      this.proposeText(this.queuedText);
    }
  }

  endChat = () => {
    const tunnel = this.tunnel;
    const channel = this.channel;
    const transcript = this.transcript;
    if (!tunnel || !channel || !transcript || this.status !== "playing") return;
    try {
      const root = transcript.root();
      const half = tunnel.buildSettlementHalfWithRoot(this.createdAt, root, 0n);
      channel.sendPeer({
        t: "settle",
        sig: toHex(half.sigSelf),
        root: toHex(root),
      });
      this.status = "settling";
      this.emit();
    } catch (e) {
      this.fail(e);
    }
  };

  private async submitClose(
    tunnelId: string,
    coSigned: Parameters<typeof settleViaBackend>[0]["settlement"],
    transcript: Transcript,
  ) {
    const deps = this.deps!;
    await settleViaBackend({
      tunnelId,
      settlement: coSigned as never,
      transcript: transcript.toRecord().entries,
      label: GAME_KEY,
      fallbackClose: async () => {
        return closeCooperativeWithRoot({
          signExec: isDopamintConfigured
            ? (deps.sponsoredSignExec as never)
            : (deps.signExec as never),
          tunnelId,
          settlement: coSigned as never,
          coinType: isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined,
        });
      },
    });
  }

  reset = (emit = true) => {
    this.mp?.close();
    this.mp = null;
    this.channel = null;
    this.tunnel = null;
    this.transcript = null;
    this.createdAt = 0n;
    this.role = null;
    this.messages = [];
    this.queuedText = null;
    this.closed = false;
    this.error = null;
    this.status = "idle";
    if (emit) this.emit();
  };
}

const sessions = new Map<string, ChatSession>();

function getSession(windowId: string): ChatSession {
  let s = sessions.get(windowId);
  if (!s) {
    s = new ChatSession();
    sessions.set(windowId, s);
    const created = s;
    registerWindowDisposer(windowId, "chat-session", () => {
      created.reset(false);
      sessions.delete(windowId);
    });
  }
  return s;
}

export function useChatSession(windowId: string): ChatSessionView {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();

  const session = useMemo(() => getSession(windowId), [windowId]);

  session.setDeps({
    account,
    client,
    signExec: (async (tx: never) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as never,
    sponsoredSignExec: sponsored.signExec as never,
    selectStakeCoin: sponsored.selectStakeCoin,
    prepareStake: sponsored.prepareStake,
    ensureStakeBalance: sponsored.ensureStakeBalance,
  });

  useEffect(() => {
    return () => {
      // Intentionally empty: the window-disposer handles real cleanup.
    };
  }, [session]);

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  return {
    status: snap.status,
    role: snap.role,
    messages: snap.messages,
    canSend: snap.canSend,
    queuedText: snap.queuedText,
    error: snap.error,
    findMatch: session.findMatch,
    send: session.send,
    endChat: session.endChat,
    reset: () => session.reset(),
  };
}
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
cd frontend && pnpm run typecheck
```

Expected: compile passes (may reveal import/path issues; fix before continuing).

- [ ] **Step 4: Run tests**

Run:

```bash
cd frontend && node --import tsx --test src/games/chat/useChatSession.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/chat/useChatSession.ts frontend/src/games/chat/useChatSession.test.ts
git commit -m "feat(chat): add useChatSession hook"
```

---

### Task 4: Chat UI components

**Files:**

- Create: `frontend/src/games/chat/ChatThread.tsx`
- Create: `frontend/src/games/chat/ChatWindow.tsx`
- Modify: `frontend/src/games/chat/index.ts`

- [ ] **Step 1: Create ChatThread**

Create `frontend/src/games/chat/ChatThread.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Loader2, PhoneOff } from "lucide-react";
import type { ChatSessionView } from "./useChatSession";

interface ChatThreadProps extends ChatSessionView {}

export function ChatThread({
  status,
  messages,
  canSend,
  queuedText,
  error,
  findMatch,
  send,
  endChat,
  reset,
}: ChatThreadProps) {
  const [draft, setDraft] = useState("");

  const isBusy =
    status === "matching" || status === "funding" || status === "settling";
  const isLive = status === "playing";

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-arena-muted">
        <span className="flex items-center gap-1.5">
          {isLive && (
            <span className="size-1.5 animate-pulse rounded-full bg-arena-accent" />
          )}
          {status}
        </span>
        {error && (
          <span className="text-destructive truncate max-w-[60%]">{error}</span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-md border border-arena-edge/60 bg-arena-bg/40 p-2">
        {messages.length === 0 && status === "idle" && (
          <span className="text-[11px] text-arena-muted">
            Click Find Match to start chatting.
          </span>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[80%] rounded-lg px-3 py-1.5 text-xs ${
              m.from === "me"
                ? "self-end bg-arena-accent text-arena-bg"
                : "self-start border border-arena-edge bg-arena-bg text-arena-text"
            }`}
          >
            {m.text}
          </div>
        ))}
        {queuedText && (
          <div className="self-end max-w-[80%] rounded-lg border border-dashed border-arena-accent/50 px-3 py-1.5 text-xs text-arena-muted">
            {queuedText}
          </div>
        )}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          send(draft.trim());
          setDraft("");
        }}
      >
        <Input
          className="flex-1 text-xs"
          placeholder={isLive ? "Type a message…" : "Waiting for match…"}
          disabled={!isLive}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          type="submit"
          size="icon"
          disabled={!isLive || !canSend || isBusy}
        >
          <Send className="size-4" />
        </Button>
      </form>

      <div className="flex gap-2">
        {status === "idle" || status === "error" ? (
          <Button
            className="flex-1"
            size="sm"
            onClick={findMatch}
            disabled={isBusy}
          >
            {isBusy ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            Find Match
          </Button>
        ) : (
          <Button
            className="flex-1"
            size="sm"
            variant="destructive"
            onClick={endChat}
            disabled={!isLive || isBusy}
          >
            <PhoneOff className="mr-1 size-3" />
            End Chat
          </Button>
        )}
        {(status === "settled" || status === "error") && (
          <Button size="sm" variant="outline" onClick={reset}>
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create ChatWindow**

Create `frontend/src/games/chat/ChatWindow.tsx`:

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { GameWindowProps } from "@/games/types";
import { useChatSession } from "./useChatSession";
import { ChatThread } from "./ChatThread";
import { ChatSpectator } from "./ChatSpectator";

export function ChatWindow({ windowId }: GameWindowProps) {
  const session = useChatSession(windowId);

  return (
    <Tabs defaultValue="play" className="flex h-full flex-col">
      <TabsList className="mx-3 mt-2 grid w-auto grid-cols-2">
        <TabsTrigger value="play">Play</TabsTrigger>
        <TabsTrigger value="spectate">Spectator</TabsTrigger>
      </TabsList>
      <TabsContent
        value="play"
        className="min-h-0 flex-1 data-[state=inactive]:hidden"
      >
        <ChatThread {...session} />
      </TabsContent>
      <TabsContent
        value="spectate"
        className="min-h-0 flex-1 data-[state=inactive]:hidden"
      >
        <ChatSpectator />
      </TabsContent>
    </Tabs>
  );
}
```

- [ ] **Step 3: Register the real window**

Modify `frontend/src/games/chat/index.ts`:

```ts
import { register } from "../registry";
import { ChatWindow } from "./ChatWindow";

register({
  id: "chat",
  name: "Chat",
  description: "Staked chat against a bot, with a bot-vs-bot spectator feed.",
  catalog: true,
  icon: "💬",
  image: "/games/chat-app.png",
  Window: ChatWindow,
});
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
cd frontend && pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/chat/ChatThread.tsx frontend/src/games/chat/ChatWindow.tsx frontend/src/games/chat/index.ts
git commit -m "feat(chat): add ChatThread and ChatWindow"
```

---

### Task 5: Bot-vs-bot spectator tab

**Files:**

- Create: `frontend/src/games/chat/useChatSpectator.ts`
- Create: `frontend/src/games/chat/ChatSpectator.tsx`

- [ ] **Step 1: Implement the spectator hook**

Create `frontend/src/games/chat/useChatSpectator.ts`:

```ts
import { useEffect, useState } from "react";
import {
  resolveChatBackendUrl,
  subscribeChatLive,
  fetchChatTopic,
  type ChatTranscriptMessage,
} from "@/backend/chat";

export interface ChatSpectatorView {
  messages: ChatTranscriptMessage[];
  topic: string | null;
  connected: boolean;
}

export function useChatSpectator(): ChatSpectatorView {
  const [messages, setMessages] = useState<ChatTranscriptMessage[]>([]);
  const [topic, setTopic] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const base = resolveChatBackendUrl();
    let mounted = true;

    fetchChatTopic(base).then((t) => {
      if (mounted && t) setTopic(t);
    });

    const unsubscribe = subscribeChatLive(base, (snapshot) => {
      if (!mounted) return;
      setMessages(snapshot.messages);
      setConnected(true);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return { messages, topic, connected };
}
```

- [ ] **Step 2: Implement ChatSpectator**

Create `frontend/src/games/chat/ChatSpectator.tsx`:

```tsx
import { useChatSpectator } from "./useChatSpectator";

export function ChatSpectator() {
  const { messages, topic, connected } = useChatSpectator();

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-arena-muted">
        <span className="flex items-center gap-1.5">
          <span
            className={`size-1.5 rounded-full ${connected ? "bg-arena-accent animate-pulse" : "bg-arena-muted"}`}
          />
          {connected ? "live feed" : "connecting…"}
        </span>
        {topic && <span className="truncate max-w-[60%]">Topic: {topic}</span>}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-md border border-arena-edge/60 bg-arena-bg/40 p-2">
        {messages.length === 0 && (
          <span className="text-[11px] text-arena-muted">
            Waiting for bot-vs-bot messages…
          </span>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[90%] rounded-lg px-3 py-1.5 text-xs ${
              m.sender === "A"
                ? "self-end bg-arena-accent text-arena-bg"
                : "self-start border border-arena-edge bg-arena-bg text-arena-text"
            }`}
          >
            <span className="mr-1 text-[10px] opacity-70">{m.sender}:</span>
            {m.text}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
cd frontend && pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/chat/useChatSpectator.ts frontend/src/games/chat/ChatSpectator.tsx
git commit -m "feat(chat): add bot-vs-bot spectator tab"
```

---

### Task 6: Wire chat tests into the test runner

**Files:**

- Modify: `frontend/package.json`

- [ ] **Step 1: Add chat test globs**

In `frontend/package.json`, update the `test` script to include chat tests:

```json
"test": "node --import tsx --test \"src/agent/**/*.test.ts\" \"src/components/**/*.test.ts\" \"src/backend/**/*.test.ts\" \"src/pvp/**/*.test.ts\" \"src/games/blackjack/*.test.ts\" \"src/games/battleship/**/*.test.ts\" \"src/games/ticTacToe/tttColdLoad.test.ts\" \"src/games/quantumPoker/**/*.test.ts\" \"src/games/chat/**/*.test.ts\"",
```

- [ ] **Step 2: Run the full frontend test suite**

Run:

```bash
cd frontend && pnpm test
```

Expected: all tests pass (existing + new chat tests).

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json
git commit -m "build(chat): include chat tests in test runner"
```

---

## Self-review checklist

- [x] User-vs-bot chat uses the tunnel for every move.
- [x] Bot-vs-bot spectator subscribes to `/v1/chat/live` SSE.
- [x] Incoming opponent text is decoded from MOVE frames via `interceptChatFrames`.
- [x] Stake is 1 DOPAMINT per seat using `openSharedTunnelStaked` / `depositStakeStaked`.
- [x] Cooperative close mirrors the PvP settle pattern with root-anchored settlement.
- [x] Chat is registered as a catalog game with a real `Window` component.
- [x] Tests are included for the frame interceptor, backend URL builder, and pure helpers.
- [x] No placeholders or TODOs remain in the plan.

## Verification

After all tasks:

```bash
cd frontend
pnpm run typecheck
pnpm test
pnpm run dev
```

Then open the app, launch **Chat** from the catalog, and:

1. Click **Find Match** in the Play tab (requires a connected wallet and the backend/agent running).
2. Type a message and confirm it appears in the tunnel transcript.
3. Switch to the **Spectator** tab and confirm bot-vs-bot messages stream in.
