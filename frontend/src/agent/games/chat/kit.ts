import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  ChatProtocol,
  type ChatState,
  type ChatMove,
} from "sui-tunnel-ts/protocol/chat";
import { defaultStateHash } from "@/agent/stateHash";
import type { BotContext, GameBot, GameKit } from "@/agent/gameKit";

/** A simple echo bot that alternates turns for sane self-play. Chat has no enforced turn order,
 *  but alternating avoids both parties speaking on the same tick. */
class ChatBot implements GameBot<ChatState, ChatMove> {
  private readonly seat: Party;

  constructor(seat: Party, _ctx: BotContext) {
    this.seat = seat;
  }

  plan(state: ChatState): ChatMove | null {
    const isATurn = state.messageCount % 2n === 0n;
    if (this.seat === "A" && !isATurn) return null;
    if (this.seat === "B" && isATurn) return null;
    return { kind: "msg", text: `msg${state.messageCount}` };
  }

  confirm(): void {
    // No retained memory beyond the public state.
  }

  abort(): void {
    // No retained memory.
  }
}

export function createChatKit(stake: bigint): GameKit<ChatState, ChatMove> {
  const protocol = new ChatProtocol();
  return {
    id: "chat",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) => new ChatBot(seat, ctx),
    defaultStake: stake,
  };
}
