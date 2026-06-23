import type { ChatState, ChatMove } from "sui-tunnel-ts/protocol/chat";

export type ChatRole = "user" | "assistant";

/** One rendered line in the local transcript. The protocol only stores a rolling digest,
 *  so this is the source of truth for display. */
export interface ChatMessage {
  role: ChatRole;
  text: string;
}

/** Build a user (Party A) move from raw input. */
export function buildUserMove(text: string): ChatMove {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("chat message must be non-empty");
  }
  return { kind: "msg", text: trimmed };
}

/** Build a bot (Party B) move from the LLM reply. */
export function buildBotMove(text: string): ChatMove {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("bot reply must be non-empty");
  }
  return { kind: "msg", text: trimmed };
}

/** Render-friendly snapshot of the on-chain ChatState. */
export interface ChatView {
  messageCount: number;
  lastSender: "A" | "B" | null;
  balanceA: number;
  balanceB: number;
}

export function deriveView(state: ChatState): ChatView {
  return {
    messageCount: Number(state.messageCount),
    lastSender: state.lastSender,
    balanceA: Number(state.balanceA),
    balanceB: Number(state.balanceB),
  };
}
