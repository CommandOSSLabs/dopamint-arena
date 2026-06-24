import { useLiveChat } from "../../hooks/useLiveChat.ts";
import type { ChatApiClient } from "../../lib/chatApi.ts";

export interface BotVsBotSpectatorProps {
  api: ChatApiClient;
}

export function BotVsBotSpectator({ api }: BotVsBotSpectatorProps) {
  const { messages, error } = useLiveChat(api);

  return (
    <div className="flex flex-col h-full border rounded-lg overflow-hidden">
      <div className="p-3 border-b font-semibold">Bot vs Bot Spectator</div>
      {error && <div className="p-2 text-destructive text-sm">{error}</div>}
      <div className="flex-1 p-3 overflow-y-auto space-y-2">
        {messages.length === 0 && (
          <div className="text-muted-foreground text-sm">Waiting for bots to start chatting...</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className="rounded-lg bg-muted px-3 py-2">
            <div className="text-xs opacity-70">{m.sender}</div>
            <div className="text-sm">{m.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
