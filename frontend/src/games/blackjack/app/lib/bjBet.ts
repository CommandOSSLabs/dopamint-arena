/**
 * UI-facing blackjack bet helpers, decoupled from the protocol. `BET_OPTIONS` are the chip
 * denominations shown as bet buttons; `bjBetMove` clamps a chosen amount to the legal
 * [MIN_BET, maxBet(state)] window and returns the SDK `bet` move.
 */
import {
  MIN_BET,
  maxBet,
  type BlackjackState,
  type BlackjackMove,
} from "sui-tunnel-ts/protocol/blackjack";

/** Chip denominations offered as bet buttons (filtered to <= the table max each round in the UI). */
export const BET_OPTIONS = [1, 2, 5, 10] as const;

/** Build a `bet` move, clamped to [MIN_BET, maxBet(state)]. */
export function bjBetMove(
  amount: number,
  state: BlackjackState,
): Extract<BlackjackMove, { kind: "bet" }> {
  const cap = maxBet(state);
  let amt = BigInt(Math.floor(amount));
  if (amt < MIN_BET) amt = MIN_BET;
  if (amt > cap) amt = cap;
  return { kind: "bet", amount: amt };
}
