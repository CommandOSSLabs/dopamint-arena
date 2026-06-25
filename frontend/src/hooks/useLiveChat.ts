import { useEffect, useState } from "react";
import type { ChatApiClient, LiveMessage } from "../lib/chatApi.ts";

export function useLiveChat(api: ChatApiClient) {
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = api.subscribeLive((msg) => {
      setMessages((prev) => [...prev, msg]);
    });
    return unsubscribe;
  }, [api]);

  return { messages, error };
}
