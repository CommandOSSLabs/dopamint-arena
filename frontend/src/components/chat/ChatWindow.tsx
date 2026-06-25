import { useChatSession } from "../../hooks/useChatSession.ts";
import type { ChatApiClient } from "../../lib/chatApi.ts";
import type { ChatTransport } from "../../lib/chatSession.ts";
import { ChatMessage } from "./ChatMessage.tsx";
import { ChatInput } from "./ChatInput.tsx";

export interface ChatWindowProps {
  api: ChatApiClient;
  transport: ChatTransport;
  myName: string;
}

export function ChatWindow({ api, transport, myName }: ChatWindowProps) {
  const { topic, input, setInput, messages, send, loading, error } =
    useChatSession({
      api,
      transport,
      myName,
    });

  return (
    <div className="flex flex-col h-full border rounded-lg overflow-hidden">
      <div className="p-3 border-b font-semibold">
        {topic ? `Topic: ${topic}` : "Loading topic..."}
      </div>
      {error && <div className="p-2 text-destructive text-sm">{error}</div>}
      <div className="flex-1 p-3 overflow-y-auto">
        {messages.map((m, i) => (
          <ChatMessage key={i} sender={m.sender} text={m.text} isMe={m.isMe} />
        ))}
      </div>
      <ChatInput
        value={input}
        onChange={setInput}
        onSend={send}
        loading={loading}
      />
    </div>
  );
}
