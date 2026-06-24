/**
 * Pure helpers for the arena Chat game. No React, no timers, no Vite-only imports —
 * just the chat protocol and message shaping, so it is trivially unit-tested under tsx.
 */
import { ChatProtocol } from "../../../../sui-tunnel-ts/src/protocol/chat.ts";

export type ChatSessionStatus =
  | "idle"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface ChatMessage {
  sender: "You" | "Bot";
  text: string;
}

export function createChatProtocol(_tunnelId: string): ChatProtocol {
  return new ChatProtocol();
}

export function toChatApiMessages(
  messages: ChatMessage[],
): { role: "user" | "assistant"; content: string }[] {
  return messages.map((m) => ({
    role: m.sender === "You" ? "user" : "assistant",
    content: m.text,
  }));
}
