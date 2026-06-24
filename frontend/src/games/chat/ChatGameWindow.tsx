import { useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ChatInput } from "@/components/chat/ChatInput";
import { BotVsBotSpectator } from "@/components/chat/BotVsBotSpectator";
import { ChatApiClient } from "@/lib/chatApi";
import type { GameWindowProps } from "../types";
import { useArenaChatSession } from "./useArenaChatSession";

export default function ChatGameWindow({ windowId }: GameWindowProps) {
  const account = useCurrentAccount();
  const [activeTab, setActiveTab] = useState<"play" | "spectator">("play");
  const [input, setInput] = useState("");
  const session = useArenaChatSession(windowId);

  const handleSend = () => {
    if (!input.trim()) return;
    session.send(input);
    setInput("");
  };

  const renderPlay = () => {
    switch (session.status) {
      case "idle":
        return (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="text-center space-y-1">
              <p className="font-semibold">Chat with a bot over a tunnel</p>
              <p className="text-sm text-muted-foreground">
                Stake 1 DOPAMINT per seat. Gas is sponsored.
              </p>
            </div>
            {account ? (
              <Button onClick={session.start}>Start Chat</Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Connect a wallet to stake the tunnel.
              </p>
            )}
          </div>
        );
      case "funding":
        return (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            <p className="text-sm text-muted-foreground">Funding tunnel…</p>
          </div>
        );
      case "playing":
        return (
          <div className="flex flex-col h-full border rounded-lg overflow-hidden">
            <div className="p-3 border-b font-semibold">
              {session.topic ? `Topic: ${session.topic}` : "Loading topic…"}
            </div>
            {session.error && (
              <div className="p-2 text-destructive text-sm">
                {session.error}
              </div>
            )}
            <div className="flex-1 p-3 overflow-y-auto">
              {session.messages.map((m, i) => (
                <ChatMessage
                  key={i}
                  sender={m.sender}
                  text={m.text}
                  isMe={m.sender === "You"}
                />
              ))}
            </div>
            <div className="flex justify-end p-2 border-t">
              <Button variant="outline" onClick={session.settleNow}>
                Settle
              </Button>
            </div>
            <ChatInput
              value={input}
              onChange={setInput}
              onSend={handleSend}
              loading={!session.canSend}
            />
          </div>
        );
      case "settling":
      case "settled":
      case "error":
        return (
          <div className="flex flex-col h-full border rounded-lg overflow-hidden">
            <div className="p-3 border-b font-semibold flex items-center gap-2">
              <span>{session.topic ? `Topic: ${session.topic}` : "Chat"}</span>
              <span className="text-xs uppercase text-muted-foreground">
                {session.status}
              </span>
            </div>
            {session.error && (
              <div className="p-2 text-destructive text-sm">
                {session.error}
              </div>
            )}
            <div className="flex-1 p-3 overflow-y-auto">
              {session.messages.map((m, i) => (
                <ChatMessage
                  key={i}
                  sender={m.sender}
                  text={m.text}
                  isMe={m.sender === "You"}
                />
              ))}
            </div>
            <div className="p-2 border-t">
              <Button onClick={session.reset}>New Chat</Button>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col h-full p-2">
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "play" | "spectator")}
      >
        <TabsList>
          <TabsTrigger value="play">Play</TabsTrigger>
          <TabsTrigger value="spectator">Spectator</TabsTrigger>
        </TabsList>
        <TabsContent value="play" className="flex flex-col h-full">
          {renderPlay()}
        </TabsContent>
        <TabsContent value="spectator" className="flex flex-col h-full">
          <BotVsBotSpectator
            api={new ChatApiClient(import.meta.env.VITE_BACKEND_URL ?? "")}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
