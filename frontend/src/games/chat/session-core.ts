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

/** Modes the chat window can run in. */
export type ChatMode = "chat" | "debate";

/** Random debate topics for AI-vs-AI mode. */
export const DEBATE_TOPICS = [
  "Should artificial intelligence be allowed to make life-or-death decisions?",
  "Is universal basic income a good response to automation?",
  "Should social media platforms be held legally responsible for user content?",
  "Is space exploration worth the cost when Earth has urgent problems?",
  "Should governments ban cryptocurrency to fight crime?",
  "Is remote work better for society than office culture?",
  "Should genetic engineering in humans be permitted?",
  "Is a four-day work week realistic and beneficial?",
  "Should college education be free for everyone?",
  "Are video games a positive or negative influence on young people?",
  "Should cars be banned from city centers?",
  "Is nuclear energy the best path away from fossil fuels?",
  "Should companies be allowed to collect personal data for targeted ads?",
  "Is censorship ever justified in a free society?",
  "Should animals have the same legal rights as humans?",
  "Is homeschooling better than traditional schooling?",
  "Should the voting age be lowered to 16?",
  "Is globalization more helpful or harmful to developing nations?",
  "Should professional athletes be role models?",
  "Is it ethical to eat meat?",
];

export function randomDebateTopic(rng = Math.random): string {
  return DEBATE_TOPICS[Math.floor(rng() * DEBATE_TOPICS.length)];
}

const DEBATE_SYSTEM_A =
  "You are Party A in a structured debate. You argue FOR the topic. Keep replies to 1-2 sentences, be direct, and respond to the opponent's last point.";

const DEBATE_SYSTEM_B =
  "You are Party B in a structured debate. You argue AGAINST the topic. Keep replies to 1-2 sentences, be direct, and respond to the opponent's last point.";

export function debateSystemPrompt(party: "A" | "B"): string {
  return party === "A" ? DEBATE_SYSTEM_A : DEBATE_SYSTEM_B;
}

/** Format a debate transcript for the LLM.
 *
 * The topic is always presented as the user's prompt. The current party's own
 * prior replies are shown as assistant messages, and the opponent's replies are
 * shown as user messages, so the model always responds as the assistant to the
 * opponent's last point. The topic entry in `history` is skipped to avoid
 * duplication. A final user prompt nudges the model to actually produce a
 * rebuttal (some small models return empty output without it).
 */
export function debateMessages(
  topic: string,
  history: ChatMessage[],
  party: "A" | "B",
): { role: ChatRole; content: string }[] {
  const ownTranscriptRole: ChatRole = party === "A" ? "user" : "assistant";
  return [
    { role: "user", content: topic },
    ...history
      .slice(1)
      .map((m) => ({
        role: m.role === ownTranscriptRole ? "assistant" : ("user" as ChatRole),
        content: m.text,
      })),
    {
      role: "user",
      content: `Party ${party}, give your rebuttal now.`,
    },
  ];
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
