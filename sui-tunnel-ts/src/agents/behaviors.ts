/**
 * Agent behaviors (Deliverable 9): each maps to a tunnel protocol the agent plays.
 * payment = payment spammer, blackjack/poker/tictactoe = game players, chat = chat spammer.
 */

import { Protocol } from "../protocol/Protocol";
import { BlackjackProtocol } from "../protocol/blackjack";
import { ChatProtocol } from "../protocol/chat";
import { PaymentsProtocol } from "../protocol/payments";
import { QuantumPokerProtocol } from "../protocol/quantumPoker";
import { TicTacToeProtocol } from "../protocol/ticTacToe";

export type BehaviorName =
  | "payment"
  | "blackjack"
  | "tictactoe"
  | "chat"
  | "poker";

export const BEHAVIOR_NAMES: BehaviorName[] = [
  "payment",
  "blackjack",
  "tictactoe",
  "chat",
  "poker",
];

/** Construct a fresh protocol instance for a behavior. */
export function createBehaviorProtocol(
  name: BehaviorName,
): Protocol<unknown, unknown> {
  switch (name) {
    case "payment":
      return new PaymentsProtocol() as unknown as Protocol<unknown, unknown>;
    case "blackjack":
      return new BlackjackProtocol() as unknown as Protocol<unknown, unknown>;
    case "tictactoe":
      return new TicTacToeProtocol() as unknown as Protocol<unknown, unknown>;
    case "chat":
      return new ChatProtocol() as unknown as Protocol<unknown, unknown>;
    case "poker":
      return new QuantumPokerProtocol() as unknown as Protocol<
        unknown,
        unknown
      >;
    default: {
      const _exhaustive: never = name;
      throw new Error(`unknown behavior: ${_exhaustive}`);
    }
  }
}

/** Parse a comma-separated behaviors string (CLI), validating each name. */
export function parseBehaviors(s: string): BehaviorName[] {
  const out = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean) as BehaviorName[];
  for (const b of out) {
    if (!BEHAVIOR_NAMES.includes(b)) throw new Error(`unknown behavior: ${b}`);
  }
  return out.length ? out : BEHAVIOR_NAMES;
}
