import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, RotateCcw, Send, Sparkles, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChat } from "./useChat";
import type { GameWindowProps } from "../types";

export function ChatWindow(_props: GameWindowProps) {
  const { messages, isStreaming, error, send, retry } = useChat();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || isStreaming) return;
    const text = draft;
    setDraft("");
    await send(text);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-card/50">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Sparkles className="size-3.5 text-primary" />
          AI Chat
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span
            className={`size-1.5 rounded-full ${isStreaming ? "animate-pulse bg-primary" : "bg-success"}`}
          />
          {isStreaming ? "thinking…" : "online"}
        </div>
      </div>

      <div
        ref={listRef}
        className="min-h-0 flex-1 space-y-3 overflow-auto p-3 font-mono text-xs"
      >
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Bot className="size-8 opacity-40" />
            <p>Ask the assistant anything.</p>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex gap-2 ${m.role === "user" ? "flex-row-reverse" : ""}`}
          >
            <div
              className={`grid size-6 shrink-0 place-items-center rounded-full border border-border ${
                m.role === "user" ? "bg-secondary" : "bg-primary/10"
              }`}
            >
              {m.role === "user" ? (
                <User className="size-3" />
              ) : (
                <Bot className="size-3 text-primary" />
              )}
            </div>
            <div
              className={`max-w-[80%] rounded-lg border px-2.5 py-1.5 leading-relaxed ${
                m.role === "user"
                  ? "border-primary/30 bg-primary/10 text-foreground"
                  : "border-border bg-secondary/50 text-foreground/90"
              }`}
            >
              {m.content || (isStreaming ? "…" : "")}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="flex items-center justify-between border-y border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <span className="truncate">{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={retry}
            aria-label="Retry"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        </div>
      )}

      <form
        onSubmit={submit}
        className="flex shrink-0 items-center gap-2 border-t border-border p-2"
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message…"
          className="h-8 font-mono text-xs"
          aria-label="Chat message"
          disabled={isStreaming}
        />
        <Button
          type="submit"
          size="icon-sm"
          disabled={isStreaming || !draft.trim()}
          aria-label="Send message"
        >
          <Send className="size-3.5" />
        </Button>
      </form>
    </div>
  );
}
