import { useCallback, useEffect, useRef, useState } from "react";
import { chatProtocol } from "sui-tunnel-ts/protocol/chat";
import type { ChatApiClient } from "../lib/chatApi.ts";
import { interceptChatFrames, type ChatTransport } from "../lib/chatSession.ts";

export interface ChatMessage {
  sender: string;
  text: string;
  isMe: boolean;
}

export interface UseChatSessionOptions {
  api: ChatApiClient;
  transport: ChatTransport;
  myName: string;
}

export function useChatSession({
  api,
  transport,
  myName,
}: UseChatSessionOptions) {
  const [topic, setTopic] = useState<string>("");
  const [input, setInput] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const protocolRef = useRef(chatProtocol());

  useEffect(() => {
    let mounted = true;
    api
      .topic()
      .then((t) => {
        if (mounted) setTopic(t);
      })
      .catch((e) => {
        if (mounted) setError(String(e));
      });
    return () => {
      mounted = false;
    };
  }, [api]);

  useEffect(() => {
    const intercepted = interceptChatFrames(transport, {
      onMessage: (sender, text) => {
        setMessages((prev) => [
          ...prev,
          { sender, text, isMe: sender === myName },
        ]);
      },
    });
    intercepted.onFrame((bytes) => {
      try {
        protocolRef.current.applyMove(bytes);
      } catch {
        // not a protocol move; ignore
      }
    });
    return () => {
      // The simple ChatTransport interface does not support unsubscription.
      // The intercepted frame handler is discarded when the effect is cleaned up.
    };
  }, [transport, myName]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMessages((prev) => [...prev, { sender: myName, text, isMe: true }]);
    setLoading(true);
    try {
      const move = protocolRef.current.createMove(text);
      protocolRef.current.applyMove(move);
      transport.send(move);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [input, myName, transport]);

  return { topic, input, setInput, messages, send, loading, error };
}
