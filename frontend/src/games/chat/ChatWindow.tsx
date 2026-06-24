import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, Loader2, MessageSquare, RotateCcw, Send, Sparkles, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChatSession } from "./useChatSession";
import type { GameWindowProps } from "../types";

export function ChatWindow({ windowId }: GameWindowProps) {
  const {
    status,
    mode,
    transcript,
    error,
    isReplying,
    exchanges,
    topic,
    send,
    reset,
    setMode,
    startAuto,
    stopAuto,
  } = useChatSession(windowId);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, isReplying]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || isReplying) return;
    const text = draft;
    setDraft("");
    await send(text);
  };

  const showInput = mode === "chat" && (status === "idle" || status === "chatting");
  const inputDisabled = mode !== "chat" || isReplying;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-card/50">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Sparkles className="size-3.5 text-primary" />
          AI Chat
        </div>
        {mode === "debate" && status === "debating" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Exchange {exchanges + 1}
          </div>
        )}
      </div>

      {(status === "opening" || status === "closing") && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-card/80 backdrop-blur-sm">
          <Loader2 className="size-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">
            {status === "opening"
              ? "Opening secure session…"
              : "Closing session…"}
          </p>
        </div>
      )}

      {status === "error" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Bot className="size-10 text-destructive" />
          <p className="max-w-[16rem] text-sm text-muted-foreground">
            {error ?? "Something went wrong."}
          </p>
          <Button onClick={reset} variant="outline" className="gap-2">
            <RotateCcw className="size-4" />
            Try again
          </Button>
        </div>
      )}

      {status !== "error" && (
        <>
          <div
            ref={listRef}
            className="min-h-0 flex-1 space-y-3 overflow-auto p-3 font-mono text-xs"
          >
            {transcript.length === 0 && status === "idle" && (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
                <Bot className="size-8 opacity-40" />
                <div className="flex gap-2">
                  <Button
                    variant={mode === "chat" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setMode("chat")}
                    className="gap-2"
                  >
                    <MessageSquare className="size-4" />
                    Chat with AI
                  </Button>
                  <Button
                    variant={mode === "debate" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setMode("debate")}
                    className="gap-2"
                  >
                    <Bot className="size-4" />
                    AI vs AI
                  </Button>
                </div>
                <p className="text-center text-xs">
                  {mode === "chat"
                    ? "Ask the assistant anything."
                    : "Two LLMs debate a random topic for 20 exchanges, then restart."}
                </p>
              </div>
            )}
            {transcript.length === 0 && status === "chatting" && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Bot className="size-8 opacity-40" />
                <p>Session ready. Say something.</p>
              </div>
            )}
            {topic && status === "debating" && transcript.length > 0 && (
              <div className="rounded border border-primary/30 bg-primary/10 p-2 text-center text-xs text-foreground">
                Topic: {topic}
              </div>
            )}
            {transcript.map((m, i) => (
              <div
                key={i}
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
                  {m.text ||
                    (isReplying &&
                    i === transcript.length - 1 &&
                    m.role === "assistant"
                      ? "…"
                      : "")}
                </div>
              </div>
            ))}
          </div>

          {showInput && (
            <form
              onSubmit={submit}
              className="flex shrink-0 items-center gap-2 border-t border-border p-2"
            >
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type a message..."
                className="h-8 font-mono text-xs"
                aria-label="Chat message"
                disabled={inputDisabled}
              />
              <Button
                type="submit"
                size="icon-sm"
                disabled={!draft.trim() || isReplying}
                aria-label="Send message"
              >
                <Send className="size-3.5" />
              </Button>
            </form>
          )}

          {mode === "debate" && status === "idle" && (
            <div className="flex shrink-0 items-center justify-center gap-2 border-t border-border p-2">
              <Button onClick={startAuto} className="gap-2">
                <Bot className="size-4" />
                Start AI Debate
              </Button>
            </div>
          )}

          {mode === "debate" && status === "debating" && (
            <div className="flex shrink-0 items-center justify-between border-t border-border p-2">
              <span className="text-xs text-muted-foreground">
                Exchange {exchanges + 1} / 20
              </span>
              <Button onClick={stopAuto} variant="outline" size="sm">
                Stop
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
