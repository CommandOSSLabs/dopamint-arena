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
