import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { ChatProtocol } from "sui-tunnel-ts/protocol/chat";
import type { ChatState, ChatMove } from "sui-tunnel-ts/protocol/chat";

import { registerWindowDisposer } from "@/lib/windowSessions";
import type { TelemetryWriter } from "@/telemetry/TelemetryProvider";
import {
  getControlPlaneClient,
  resolveBackendUrl,
  type RegisterSessionResult,
} from "@/backend/controlPlane";
import {
  closeCooperative,
  openAndFundSelfPlay,
  readCreatedAt,
} from "@/onchain/tunnelTx";
import {
  buildBotMove,
  buildUserMove,
  debateMessages,
  debateSystemPrompt,
  randomDebateTopic,
  type ChatMessage,
  type ChatMode,
  type ChatRole,
} from "./session-core";

export type { ChatMode } from "./session-core";

interface Deps {
  report: TelemetryWriter;
  account: { address: string } | null;
  client: unknown;
  signExec: (tx: never) => Promise<{ digest: string }>;
}

export type ChatStatus =
  | "idle"
  | "opening"
  | "chatting"
  | "debating"
  | "closing"
  | "error";

export interface ChatSessionState {
  status: ChatStatus;
  mode: ChatMode;
  transcript: ChatMessage[];
  stake: number;
  error: string | null;
  isReplying: boolean;
  exchanges: number;
  topic: string | null;
}

const STAKE = 100n;
const HEARTBEAT_MS = 1000;
const DEBATE_EXCHANGE_TARGET = Number(
  import.meta.env.VITE_DEBATE_EXCHANGE_TARGET || 20,
);
const DEBATE_MAX_TOKENS = 80;

function ndjsonLines(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<string> {
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

/**
 * The chat session lives OUT of React so it survives minimize / maximize /
 * desktop reflow. It is keyed by windowId and only disposed when the window
 * is genuinely closed, at which point any on-chain tunnel is settled
 * automatically. The UI subscribes through useSyncExternalStore.
 */
export class ChatSession {
  deps: Deps | null = null;

  private status: ChatStatus = "idle";
  private mode: ChatMode = "chat";
  private transcript: ChatMessage[] = [];
  private error: string | null = null;
  private isReplying = false;
  private stake = STAKE;
  private exchanges = 0;
  private topic: string | null = null;
  private snap: ChatSessionState = {
    status: "idle",
    mode: "chat",
    transcript: [],
    stake: Number(STAKE),
    error: null,
    isReplying: false,
    exchanges: 0,
    topic: null,
  };
  private listeners = new Set<() => void>();

  private tunnel: OffchainTunnel<ChatState, ChatMove> | null = null;
  private tunnelId = "";
  private createdAt = 0n;
  private onChain = false;

  private abort: AbortController | null = null;
  private moveCount = 0;
  private actions = 0;
  private lastHeartbeat = 0;
  private session: RegisterSessionResult | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  private opening = false;
  private gen = 0;
  private autoRunning = false;
  private autoNextDelay: ReturnType<typeof setTimeout> | null = null;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): ChatSessionState => this.snap;

  private emit() {
    this.snap = {
      status: this.status,
      mode: this.mode,
      transcript: [...this.transcript],
      stake: Number(this.stake),
      error: this.error,
      isReplying: this.isReplying,
      exchanges: this.exchanges,
      topic: this.topic,
    };
    for (const l of this.listeners) l();
  }

  private setStatus(s: ChatStatus) {
    this.status = s;
    this.emit();
  }

  setMode = (mode: ChatMode) => {
    if (this.autoRunning) this.stopAuto();
    this.mode = mode;
    this.error = null;
    this.emit();
  };

  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }

  /**
   * Stream one LLM reply and append it to the transcript as the assistant.
   * Returns the final trimmed text. The caller is responsible for stepping the
   * corresponding tunnel move.
   */
  private async streamReply(
    messages: { role: ChatRole; content: string }[],
    opts: { system?: string; maxTokens?: number } = {},
  ): Promise<string> {
    const base = resolveBackendUrl();
    this.abort = new AbortController();
    const res = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages,
        system: opts.system,
        max_tokens: opts.maxTokens,
      }),
      signal: this.abort.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "request failed");
      throw new Error(detail);
    }
    if (!res.body) {
      throw new Error("no response body");
    }

    // Optimistically show an assistant placeholder.
    this.transcript = [...this.transcript, { role: "assistant", text: "" }];
    this.emit();

    const reader = ndjsonLines(res.body).getReader();
    let replyText = "";
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
        replyText += delta;
        this.transcript = this.transcript.map((m, i) =>
          i === this.transcript.length - 1 && m.role === "assistant"
            ? { ...m, text: replyText }
            : m,
        );
        this.emit();
      }
    }

    const finalReply = replyText.trim();
    if (!finalReply) {
      this.transcript = this.transcript.filter(
        (m, i) =>
          !(
            i === this.transcript.length - 1 &&
            m.role === "assistant" &&
            m.text === ""
          ),
      );
      this.emit();
      throw new Error("assistant returned an empty reply");
    }

    this.transcript = this.transcript.map((m, i) =>
      i === this.transcript.length - 1 && m.role === "assistant"
        ? { ...m, text: finalReply }
        : m,
    );
    this.emit();
    return finalReply;
  }

  private abortFetch() {
    this.abort?.abort();
    this.abort = null;
  }

  private flushHeartbeat(force: boolean) {
    const s = this.session;
    const tunnelId = this.tunnel?.tunnelId;
    if (!s || !tunnelId || this.actions === 0) return;

    const now = Date.now();
    const windowMs = now - this.lastHeartbeat;
    if (!force && windowMs < HEARTBEAT_MS) return;

    const actionsDelta = this.actions;
    this.actions = 0;
    this.lastHeartbeat = now;

    getControlPlaneClient()
      .sendHeartbeat(s.sessionId, s.statsToken, {
        tunnelId,
        nonce: String(this.moveCount),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => console.error("[chat] heartbeat failed:", e));
  }

  private startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(
      () => this.flushHeartbeat(false),
      HEARTBEAT_MS,
    );
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private async open(): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    this.gen += 1;
    const myGen = this.gen;

    const deps = this.deps;
    if (!deps) {
      this.opening = false;
      return;
    }

    if (!deps.account) {
      this.fail("connect a wallet to start chatting");
      this.opening = false;
      return;
    }

    this.setStatus("opening");

    try {
      const a = createParticipant("chat-a");
      const b = createParticipant("chat-b");
      const protocol = new ChatProtocol();

      const reads = deps.client as unknown as Parameters<
        typeof openAndFundSelfPlay
      >[0]["reads"];

      const tunnelId = await openAndFundSelfPlay({
        reads,
        signExec: deps.signExec as never,
        partyA: { address: a.address, publicKey: a.keyPair.publicKey },
        partyB: { address: b.address, publicKey: b.keyPair.publicKey },
        aAmount: this.stake,
        bAmount: this.stake,
      });

      if (this.gen !== myGen) return;

      const createdAt = await readCreatedAt(reads, tunnelId);
      if (this.gen !== myGen) return;

      const tunnel = OffchainTunnel.selfPlay(
        protocol,
        tunnelId,
        a.keyPair,
        b.keyPair,
        a.address,
        b.address,
        { a: this.stake, b: this.stake },
      );
      tunnel.onUpdate = (_u, bytes) =>
        this.deps?.report.bumpCounters({
          updates: 1,
          signatures: 2,
          verifications: 2,
          bytes,
        });

      this.tunnel = tunnel;
      this.tunnelId = tunnelId;
      this.createdAt = createdAt;
      this.onChain = true;
      this.moveCount = 0;
      this.actions = 0;
      this.lastHeartbeat = Date.now();

      deps.report.bumpCounters({ tunnelsOpened: 1 });
      deps.report.setActive(2);

      this.setStatus("chatting");
      this.startHeartbeat();

      getControlPlaneClient()
        .registerSession({
          userAddress: deps.account.address,
          game: "chat",
          tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
        })
        .then((s) => {
          this.session = s;
        })
        .catch((e) => console.error("[chat] registerSession failed:", e));
    } catch (e) {
      if (this.gen === myGen) this.fail(e);
    } finally {
      this.opening = false;
    }
  }

  send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || this.isReplying) return;

    this.error = null;
    this.isReplying = true;
    this.emit();

    let myGen = this.gen;

    try {
      if (!this.tunnel) {
        await this.open();
        // open() bumps gen internally; the caller's myGen is intentionally
        // the pre-open value, so do NOT bail on gen mismatch here. Only bail
        // if the tunnel actually failed to open.
        if (!this.tunnel) {
          // Open failed; status is already error.
          return;
        }
        // Adopt the post-open generation so the finally block can clear
        // isReplying after a normal send; otherwise isReplying stays true forever.
        myGen = this.gen;
      }

      const t = this.tunnel;

      // Step the user's message as Party A.
      const moveA = buildUserMove(trimmed);
      t.step(moveA, "A");
      this.moveCount += 1;
      this.actions += 1;
      this.transcript = [...this.transcript, { role: "user", text: trimmed }];
      this.emit();
      this.flushHeartbeat(true);

      // Stream the LLM reply from the backend.
      const messages = this.transcript.map((m) => ({
        role: m.role,
        content: m.text,
      }));
      const finalReply = await this.streamReply(messages);

      // Step the bot's final reply as Party B.
      const moveB = buildBotMove(finalReply);
      t.step(moveB, "B");
      this.moveCount += 1;
      this.actions += 1;
      this.emit();
      this.flushHeartbeat(true);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // User-initiated abort (reset/dispose while streaming) is silent.
      } else {
        console.error("[chat] send failed:", e);
        if (this.gen === myGen) this.fail(e);
      }
    } finally {
      if (this.gen === myGen) {
        this.isReplying = false;
        this.abort = null;
        this.emit();
      }
    }
  };

  startAuto = async () => {
    if (this.autoRunning || this.mode !== "debate") return;
    this.autoRunning = true;
    this.error = null;
    this.isReplying = true;
    this.exchanges = 0;
    this.setStatus("debating");
    await this.runDebateRound();
  };

  stopAuto = () => {
    this.autoRunning = false;
    this.abortFetch();
    if (this.autoNextDelay) {
      clearTimeout(this.autoNextDelay);
      this.autoNextDelay = null;
    }
    this.isReplying = false;
    this.setStatus("idle");
  };

  /**
   * Run one AI-vs-AI debate round. The first round opens the tunnel and seeds
   * Party A with a random topic. Subsequent rounds continue the same tunnel
   * until the exchange target is hit, then the tunnel is settled and a fresh
   * debate begins in the same window.
   */
  private runDebateRound = async () => {
    if (!this.autoRunning) return;

    let myGen = this.gen;

    try {
      // Ensure we have a tunnel.
      const needsOpen = this.tunnel === null;
      if (needsOpen) {
        await this.open();
        // open() bumps gen so old comparisons don't match; adopt the new gen.
        myGen = this.gen;
        if (this.tunnel === null || !this.autoRunning) return;

        // open() sets status to "chatting" for the human mode; restore debate UI.
        this.setStatus("debating");

        // Seed the debate.
        this.topic = randomDebateTopic();
        this.exchanges = 0;
        this.transcript = [];
        this.emit();

        const t = this.tunnel;
        const opening = buildUserMove(this.topic!);
        t.step(opening, "A");
        this.moveCount += 1;
        this.actions += 1;
        this.transcript = [{ role: "user", text: this.topic }];
        this.emit();
        this.flushHeartbeat(true);
      }

      const t = this.tunnel;
      if (!t || !this.topic) return;

      // Party B replies.
      const bMessages = debateMessages(this.topic, this.transcript, "B");
      const bReply = await this.streamReply(bMessages, {
        system: debateSystemPrompt("B"),
        maxTokens: DEBATE_MAX_TOKENS,
      });
      if (this.gen !== myGen || !this.autoRunning) return;
      const moveB = buildBotMove(bReply);
      t.step(moveB, "B");
      this.moveCount += 1;
      this.actions += 1;
      this.emit();
      this.flushHeartbeat(true);

      // Party A replies.
      const aMessages = debateMessages(this.topic, this.transcript, "A");
      const aReply = await this.streamReply(aMessages, {
        system: debateSystemPrompt("A"),
        maxTokens: DEBATE_MAX_TOKENS,
      });
      if (this.gen !== myGen || !this.autoRunning) return;
      const moveA = buildUserMove(aReply);
      t.step(moveA, "A");
      this.moveCount += 1;
      this.actions += 1;
      this.emit();
      this.flushHeartbeat(true);

      this.exchanges += 1;
      this.emit();

      if (this.exchanges >= DEBATE_EXCHANGE_TARGET) {
        await this.settleAndRestart();
      } else {
        // Brief pause between exchanges so the UI is readable.
        this.autoNextDelay = setTimeout(() => {
          this.autoNextDelay = null;
          void this.runDebateRound();
        }, 800);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // Stopped by user.
      } else {
        console.error("[chat] debate failed:", e);
        if (this.gen === myGen) {
          this.autoRunning = false;
          this.isReplying = false;
          this.fail(e);
        }
      }
    }
  };

  private settleAndRestart = async () => {
    if (!this.tunnel || !this.onChain || !this.deps) {
      this.resetForNextDebate();
      if (this.autoRunning) void this.runDebateRound();
      return;
    }

    this.isReplying = true;
    this.setStatus("closing");

    try {
      const settlement = this.tunnel.buildSettlement(this.createdAt);
      await closeCooperative({
        signExec: this.deps.signExec as never,
        tunnelId: this.tunnelId,
        settlement,
      });
      this.deps.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
    } catch (e) {
      console.error("[chat] debate settle failed:", e);
      this.fail(e);
      this.autoRunning = false;
      this.isReplying = false;
      return;
    }

    // Stop after the target number of exchanges so the completed debate stays
    // visible in the UI instead of immediately restarting and clearing it.
    this.autoRunning = false;
    this.isReplying = false;
    this.setStatus("idle");

    // Tear down the closed tunnel but keep the transcript/topic for reading.
    this.stopHeartbeat();
    this.tunnel = null;
    this.tunnelId = "";
    this.createdAt = 0n;
    this.onChain = false;
    this.moveCount = 0;
    this.actions = 0;
    this.lastHeartbeat = 0;
    this.session = null;
    this.deps?.report.setActive(0);
    this.emit();
  };

  private resetForNextDebate = () => {
    this.abortFetch();
    this.stopHeartbeat();
    this.tunnel = null;
    this.tunnelId = "";
    this.createdAt = 0n;
    this.onChain = false;
    this.moveCount = 0;
    this.actions = 0;
    this.lastHeartbeat = 0;
    this.session = null;
    this.transcript = [];
    this.topic = null;
    this.exchanges = 0;
    this.deps?.report.setActive(0);
    this.status = this.autoRunning ? "debating" : "idle";
    this.error = null;
    this.emit();
  };

  reset = () => {
    this.stopAuto();
    this.abortFetch();
    this.gen += 1;
    this.stopHeartbeat();
    this.tunnel = null;
    this.tunnelId = "";
    this.createdAt = 0n;
    this.onChain = false;
    this.moveCount = 0;
    this.actions = 0;
    this.lastHeartbeat = 0;
    this.session = null;
    this.isReplying = false;
    this.transcript = [];
    this.topic = null;
    this.exchanges = 0;
    this.deps?.report.setActive(0);
    this.status = "idle";
    this.error = null;
    this.emit();
  };

  dispose = () => {
    this.autoRunning = false;
    this.abortFetch();
    if (this.autoNextDelay) {
      clearTimeout(this.autoNextDelay);
      this.autoNextDelay = null;
    }
    this.gen += 1;
    this.stopHeartbeat();
    this.listeners.clear();

    const tunnel = this.tunnel;
    if (tunnel && this.onChain && this.deps) {
      this.deps.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
      this.deps.report.setActive(0);
      const settlement = tunnel.buildSettlement(this.createdAt);
      closeCooperative({
        signExec: this.deps.signExec as never,
        tunnelId: this.tunnelId,
        settlement,
      }).catch((e) => console.error("[chat] auto-settle failed:", e));
    } else {
      this.deps?.report.setActive(0);
    }

    this.tunnel = null;
    this.tunnelId = "";
    this.createdAt = 0n;
    this.onChain = false;
    this.session = null;
    this.status = "closing";
    this.emit();
  };
}

const chatSessions = new Map<string, ChatSession>();

export function getChatSession(windowId: string): ChatSession {
  let session = chatSessions.get(windowId);
  if (!session) {
    session = new ChatSession();
    chatSessions.set(windowId, session);
    const created = session;
    registerWindowDisposer(windowId, "chat", () => {
      created.dispose();
      chatSessions.delete(windowId);
    });
  }
  return session;
}

