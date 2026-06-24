import { createBehaviorProtocol, type BehaviorName } from "../../../sui-tunnel-ts/src/agents/behaviors";
import type { Protocol } from "../../../sui-tunnel-ts/src/protocol/Protocol";

const GAME_TO_BEHAVIOR: Record<string, BehaviorName> = {
  payments: "payment",
  poker: "poker",
  quantumPoker: "poker",
  blackjack: "blackjack",
  ticTacToe: "tictactoe",
  chat: "chat",
  bombIt: "bombIt",
  cross: "cross",
};

export const PLAYABLE = ["payments", "blackjack", "ticTacToe", "chat", "quantumPoker", "bombIt", "cross"] as const;

export function isPlayable(game: string): boolean {
  return game in GAME_TO_BEHAVIOR;
}

export function protocolFor(game: string): Protocol<unknown, unknown> {
  const behavior = GAME_TO_BEHAVIOR[game];
  if (!behavior) {
    throw new Error(`game "${game}" has no engine protocol (playable: ${PLAYABLE.join(", ")})`);
  }
  return createBehaviorProtocol(behavior);
}

export function gameBalances(_game: string): { a: bigint; b: bigint } {
  return { a: 1_000_000n, b: 1_000_000n };
}
