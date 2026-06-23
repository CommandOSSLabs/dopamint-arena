import { useCallback, useEffect, useRef, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { ChatProtocol } from "sui-tunnel-ts/protocol/chat";
import type { ChatState, ChatMove } from "sui-tunnel-ts/protocol/chat";

import { useTelemetry } from "@/telemetry/TelemetryProvider";
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
import { buildBotMove, buildUserMove, type ChatMessage } from "./session-core";

export type SessionStatus =
  | "idle"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

const HEARTBEAT_MS = 1000;

export interface ChatSession {
  status: SessionStatus;
  transcript: ChatMessage[];
  stake: number;
  error: string | null;
  isReplying: boolean;
  start: (stake: number) => void;
  send: (text: string) => Promise<void>;
  settle: () => Promise<void>;
  reset: () => void;
}

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

export function useChatSession(): ChatSession {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [transcript, setTranscript] = useState<ChatMessage[]>([]);
  const [stake, setStake] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [isReplying, setIsReplying] = useState(false);

  const protocolRef = useRef<ChatProtocol | null>(null);
  const tunnelRef = useRef<OffchainTunnel<ChatState, ChatMove> | null>(null);
  const createdAtRef = useRef<bigint>(0n);
  const sessionRef = useRef<RegisterSessionResult | null>(null);
  const moveCountRef = useRef(0);
  const actionsRef = useRef(0);
  const lastHeartbeatRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const isReplyingRef = useRef(false);

  const flushHeartbeat = useCallback((force: boolean) => {
    const s = sessionRef.current;
    const tunnelId = tunnelRef.current?.tunnelId;
    if (!s || !tunnelId || actionsRef.current === 0) return;

    const now = Date.now();
    const windowMs = now - lastHeartbeatRef.current;
    if (!force && windowMs < HEARTBEAT_MS) return;

    const actionsDelta = actionsRef.current;
    actionsRef.current = 0;
    lastHeartbeatRef.current = now;

    getControlPlaneClient()
      .sendHeartbeat(s.sessionId, s.statsToken, {
        tunnelId,
        nonce: String(moveCountRef.current),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => console.error("[chat] heartbeat failed:", e));
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    protocolRef.current = null;
    tunnelRef.current = null;
    createdAtRef.current = 0n;
    sessionRef.current = null;
    moveCountRef.current = 0;
    actionsRef.current = 0;
    lastHeartbeatRef.current = 0;
    isReplyingRef.current = false;
    report.setActive(0);
    setStatus("idle");
    setTranscript([]);
    setStake(0);
    setError(null);
    setIsReplying(false);
  }, [report]);

  const start = useCallback(
    (nextStake: number) => {
      reset();
      const floored = Math.floor(nextStake);
      const stakeBig = BigInt(
        Math.max(0, Number.isFinite(floored) ? floored : 0),
      );
      setStake(Number(stakeBig));
      setError(null);

      if (!account) {
        setError("connect a wallet to stake the tunnel");
        setStatus("error");
        return;
      }

      const signExec = async (
        tx: Parameters<typeof signAndExecute>[0]["transaction"],
      ) => {
        const r = await signAndExecute({ transaction: tx });
        return { digest: r.digest };
      };
      const reads = client as unknown as Parameters<
        typeof openAndFundSelfPlay
      >[0]["reads"];

      (async () => {
        try {
          const a = createParticipant("chat-a");
          const b = createParticipant("chat-b");
          const protocol = new ChatProtocol();

          setStatus("funding");
          const tunnelId = await openAndFundSelfPlay({
            reads,
            signExec,
            partyA: { address: a.address, publicKey: a.keyPair.publicKey },
            partyB: { address: b.address, publicKey: b.keyPair.publicKey },
            aAmount: stakeBig,
            bAmount: stakeBig,
          });
          const createdAt = await readCreatedAt(reads, tunnelId);

          const tunnel = OffchainTunnel.selfPlay(
            protocol,
            tunnelId,
            a.keyPair,
            b.keyPair,
            a.address,
            b.address,
            { a: stakeBig, b: stakeBig },
          );
          tunnel.onUpdate = (_u, bytes) =>
            report.bumpCounters({
              updates: 1,
              signatures: 2,
              verifications: 2,
              bytes,
            });

          protocolRef.current = protocol;
          tunnelRef.current = tunnel;
          createdAtRef.current = createdAt;
          report.bumpCounters({ tunnelsOpened: 1 });
          report.setActive(2);
          setTranscript([]);
          setStatus("playing");

          sessionRef.current = null;
          moveCountRef.current = 0;
          actionsRef.current = 0;
          lastHeartbeatRef.current = Date.now();
          const cp = getControlPlaneClient();
          cp.registerSession({
            userAddress: account.address,
            game: "chat",
            tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
          })
            .then((s) => {
              sessionRef.current = s;
            })
            .catch((e) => console.error("[chat] registerSession failed:", e));
        } catch (e) {
          report.setActive(0);
          setError(String((e as Error)?.message ?? e));
          setStatus("error");
        }
      })();
    },
    [account, client, signAndExecute, report, reset],
  );

  const send = useCallback(
    async (text: string) => {
      const t = tunnelRef.current;
      if (!t) {
        setError("chat tunnel not open");
        return;
      }
      if (status !== "playing" || isReplyingRef.current) return;

      const trimmed = text.trim();
      if (!trimmed) return;

      setError(null);
      setIsReplying(true);
      isReplyingRef.current = true;
      abortRef.current = new AbortController();

      try {
        // Step the user's message as Party A.
        const moveA = buildUserMove(trimmed);
        t.step(moveA, "A");
        moveCountRef.current += 1;
        actionsRef.current += 1;
        const history: ChatMessage[] = [
          ...transcript,
          { role: "user", text: trimmed },
        ];
        setTranscript(history);

        // Ask the backend LLM for a reply.
        const base = resolveBackendUrl();
        const res = await fetch(`${base}/v1/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: history.map((m) => ({ role: m.role, content: m.text })),
          }),
          signal: abortRef.current.signal,
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => "request failed");
          throw new Error(detail);
        }
        if (!res.body) {
          throw new Error("no response body");
        }

        // Stream the reply in as an assistant placeholder.
        setTranscript((prev) => [...prev, { role: "assistant", text: "" }]);
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
            setTranscript((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = { ...last, text: replyText };
              }
              return next;
            });
          }
        }

        const finalReply = replyText.trim();
        if (!finalReply) {
          // Drop the empty assistant placeholder and surface the failure.
          setTranscript((prev) =>
            prev.filter(
              (m, i) =>
                !(
                  i === prev.length - 1 &&
                  m.role === "assistant" &&
                  m.text === ""
                ),
            ),
          );
          throw new Error("assistant returned an empty reply");
        }

        // Step the bot's final reply as Party B.
        const moveB = buildBotMove(finalReply);
        t.step(moveB, "B");
        moveCountRef.current += 1;
        actionsRef.current += 1;
        setTranscript((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { ...last, text: finalReply };
          } else {
            next.push({ role: "assistant", text: finalReply });
          }
          return next;
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          // User-initiated abort (e.g. reset while streaming) is silent.
        } else {
          console.error("[chat] send failed:", e);
          setError(String((e as Error)?.message ?? e));
        }
      } finally {
        setIsReplying(false);
        isReplyingRef.current = false;
        abortRef.current = null;
        flushHeartbeat(true);
      }
    },
    [status, transcript, flushHeartbeat],
  );

  const settle = useCallback(async () => {
    const t = tunnelRef.current;
    if (!t || status !== "playing") return;

    setStatus("settling");
    setIsReplying(false);
    isReplyingRef.current = false;
    abortRef.current?.abort();

    report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
    report.setActive(0);
    flushHeartbeat(true);

    try {
      const signExec = async (
        tx: Parameters<typeof signAndExecute>[0]["transaction"],
      ) => {
        const r = await signAndExecute({ transaction: tx });
        return { digest: r.digest };
      };
      const settlement = t.buildSettlement(createdAtRef.current);
      await closeCooperative({ signExec, tunnelId: t.tunnelId, settlement });
      setStatus("settled");
    } catch (e) {
      console.error("[chat] settle failed:", e);
      setError(String((e as Error)?.message ?? e));
      setStatus("error");
    }
  }, [status, signAndExecute, report, flushHeartbeat]);

  // Periodic heartbeat while a session is live.
  useEffect(() => {
    if (status !== "playing") return;
    const id = setInterval(() => flushHeartbeat(false), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [status, flushHeartbeat]);

  // Reset on unmount to release keys, abort fetches, and clear telemetry.
  useEffect(() => reset, [reset]);

  return {
    status,
    transcript,
    stake,
    error,
    isReplying,
    start,
    send,
    settle,
    reset,
  };
}
