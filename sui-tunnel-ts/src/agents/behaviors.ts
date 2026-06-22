/**
 * Agent behaviors (Deliverable 9): each maps to a tunnel protocol the agent plays.
 * payment = payment spammer, blackjack/poker/tictactoe = game players, chat = chat spammer.
 *
 * NOTE: there is deliberately NO `pixelduel` behavior. PixelDuelProtocol can't be
 * constructed without BOTH template commitments, which exist only after the two
 * seats run their commit-reveal handshake. A behavior here takes no commits, so it
 * couldn't build a valid duel protocol. The fleet engine instead builds the duel
 * protocol INLINE once both commits are exchanged (frontend agentEngine.ts duel
 * path, gated on spec.commitReveal); behaviors.ts stays commit-free.
 */

import { Protocol } from "../protocol/Protocol";
import { PaymentsProtocol } from "../protocol/payments";
import { BlackjackProtocol } from "../protocol/blackjack";
import { TicTacToeProtocol } from "../protocol/ticTacToe";
import { ChatProtocol } from "../protocol/chat";
import { QuantumPokerProtocol } from "../protocol/quantumPoker";
import { PixelPaintProtocol } from "../protocol/pixelPaint";

export type BehaviorName =
  | "payment"
  | "blackjack"
  | "tictactoe"
  | "chat"
  | "poker"
  | "pixelpaint";

export const BEHAVIOR_NAMES: BehaviorName[] = [
  "payment",
  "blackjack",
  "tictactoe",
  "chat",
  "poker",
  "pixelpaint",
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
    case "pixelpaint":
      return new PixelPaintProtocol({ mode: "free" }) as unknown as Protocol<
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
