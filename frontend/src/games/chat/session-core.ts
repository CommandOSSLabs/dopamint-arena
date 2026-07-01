/**
 * Pure helpers for the arena Chat game. No React, no timers, no Vite-only imports —
 * just the chat protocol and message shaping, so it is trivially unit-tested under tsx.
 */
import { ChatProtocol } from "../../../../sui-tunnel-ts/src/protocol/chat.ts";
import { canSafelyPlayNextEpisode } from "../../../../sui-tunnel-ts/src/proof/limits.ts";

/**
 * Upper bound on the tunnel updates one chat exchange costs: the human message plus
 * the bot's reply. Used as the per-episode bound when checking whether the tunnel has
 * room for another exchange before MAX_MOVES_PER_TUNNEL forces a rotate/settle.
 */
export const CHAT_MAX_MOVES_PER_TURN = 2;

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

/**
 * Chat is open-ended: its protocol never reaches a natural terminal, so the tunnel's
 * move ceiling is the ONLY stop rule. Given the current co-signed update count, returns
 * true when the tunnel is too close to MAX_MOVES_PER_TUNNEL to fit another human+bot
 * exchange — the caller should settle at this clean message boundary rather than risk
 * overrunning the cap mid-exchange.
 */
export function chatShouldSettleForMoveCap(updateCount: number): boolean {
  return !canSafelyPlayNextEpisode(updateCount, CHAT_MAX_MOVES_PER_TURN);
}
