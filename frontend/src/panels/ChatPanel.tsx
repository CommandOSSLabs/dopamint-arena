import { useEffect, useRef, useState, type FormEvent } from "react";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Panel,
  PanelAction,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "@/components/ui/panel";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMockChat } from "@/lib/useMockChat";

/** Community chat (mock): streams bot messages and appends what you send. */
export function ChatPanel({ className }: { className?: string }) {
  const { messages, send } = useMockChat();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll only the chat list (not ancestors — scrollIntoView would yank the
  // whole page on the stacked mobile layout).
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(draft);
    setDraft("");
  };

  return (
    <Panel className={className}>
      <PanelHeader>
        <PanelTitle>Community Chat</PanelTitle>
        <PanelAction>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-primary" />
            342 online
          </span>
        </PanelAction>
      </PanelHeader>
      <PanelContent className="flex flex-col overflow-hidden">
        <div
          ref={listRef}
          className="min-h-0 flex-1 space-y-1.5 overflow-auto p-3"
        >
          {messages.map((m) => (
            <div key={m.id} className="text-xs leading-snug">
              <span className="font-semibold" style={{ color: m.color }}>
                {m.user}
              </span>{" "}
              <span className="text-foreground/90">{m.text}</span>
            </div>
          ))}
        </div>
        <form
          onSubmit={submit}
          className="flex shrink-0 items-center gap-2 border-t border-border p-2"
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Message…"
            className="h-8"
            aria-label="Chat message"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="submit" size="icon-sm" aria-label="Send message">
                <Send />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Send message</TooltipContent>
          </Tooltip>
        </form>
      </PanelContent>
    </Panel>
  );
}
