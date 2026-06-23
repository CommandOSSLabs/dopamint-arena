import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Bot,
  RotateCcw,
  Send,
  Sparkles,
  User,
  Wallet,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChatSession } from "./useChatSession";
import type { GameWindowProps } from "../types";

const DEFAULT_STAKE = 100;

export function ChatWindow(_props: GameWindowProps) {
  const { status, transcript, error, isReplying, start, send, settle, reset } =
    useChatSession();
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

  const statusLabel: Record<typeof status, string> = {
    idle: "idle",
    funding: "funding…",
    playing: "playing",
    settling: "settling…",
    settled: "settled",
    error: "error",
  };

  const statusColor =
    status === "error"
      ? "bg-destructive"
      : status === "playing"
        ? "bg-success"
        : status === "funding" || status === "settling"
          ? "animate-pulse bg-primary"
          : "bg-muted";

  const canType = status === "playing" && !isReplying;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-card/50">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Sparkles className="size-3.5 text-primary" />
          AI Chat
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className={`size-1.5 rounded-full ${statusColor}`} />
          {statusLabel[status]}
          {status === "playing" && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={settle}
              aria-label="Settle tunnel"
            >
              <XCircle className="size-3" />
            </Button>
          )}
        </div>
      </div>

      {status === "idle" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
          <Bot className="size-10 opacity-40" />
          <p className="text-sm text-muted-foreground">
            Open a self-play Sui Tunnel to chat.
          </p>
          <Button onClick={() => start(DEFAULT_STAKE)} className="gap-2">
            <Wallet className="size-4" />
            Open Chat Tunnel
          </Button>
        </div>
      )}

      {status !== "idle" && (
        <>
          <div
            ref={listRef}
            className="min-h-0 flex-1 space-y-3 overflow-auto p-3 font-mono text-xs"
          >
            {transcript.length === 0 && status !== "settled" && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Bot className="size-8 opacity-40" />
                <p>Ask the assistant anything.</p>
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

          {status === "settled" && (
            <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
              <span>Tunnel settled.</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-[11px]"
                onClick={reset}
              >
                Start over
              </Button>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-between border-y border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
              <span className="truncate">{error}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={reset}
                aria-label="Reset"
              >
                <RotateCcw className="size-3.5" />
              </Button>
            </div>
          )}

          {status === "playing" && (
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
                disabled={!canType}
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
