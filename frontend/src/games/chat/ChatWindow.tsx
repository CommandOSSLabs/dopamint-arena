import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, Loader2, RotateCcw, Send, Sparkles, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChatSession } from "./useChatSession";
import type { GameWindowProps } from "../types";

export function ChatWindow({ windowId }: GameWindowProps) {
  const { status, transcript, error, isReplying, send, reset } =
    useChatSession(windowId);
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

  const showInput = status === "idle" || status === "chatting";
  const inputDisabled = status !== "chatting" || isReplying;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-card/50">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Sparkles className="size-3.5 text-primary" />
          AI Chat
        </div>
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
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Bot className="size-8 opacity-40" />
                <p>Ask the assistant anything.</p>
              </div>
            )}
            {transcript.length === 0 && status === "chatting" && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Bot className="size-8 opacity-40" />
                <p>Session ready. Say something.</p>
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
        </>
      )}
    </div>
  );
}
