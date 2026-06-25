// Pot-relative raise sizing for the human betting UI, shared by the Bot lane and PvP so both
// offer the same three sizes. The protocol's `bet` amount is the increment to THIS seat's street
// bet, so a pot-sized raise = call + pot-after-call = pot + 2·call (call = amount to call, 0 when
// first to act). Each size clamps to [minBet, maxBet]; duplicates collapse toward all-in.

export interface PokerRaiseSizes {
  /** ½-pot raise amount (the protocol `bet` increment). */
  half: bigint;
  /** Pot-sized raise amount. */
  full: bigint;
  /** All-in: the seat's whole remaining stack this hand. */
  allIn: bigint;
  /** Show the ½-pot button (hidden when it collapses into pot/all-in). */
  showHalf: boolean;
  /** Show the pot button (hidden when it collapses into all-in). */
  showFull: boolean;
  /** Show the all-in button (true whenever a raise is possible at all). */
  showAllIn: boolean;
}

export function pokerRaiseSizes(opts: {
  /** Chips already committed this hand by both seats (state.totalBetA + state.totalBetB). */
  pot: bigint;
  /** Amount this seat must call (0 when first to act). */
  callAmount: bigint;
  /** Smallest legal `bet` increment (a raise must clear the opponent's street bet). */
  minBet: bigint;
  /** Largest legal increment = this seat's remaining stack this hand. */
  maxBet: bigint;
  /** False when no raise is possible (e.g. already all-in); hides all three. */
  canBet: boolean;
}): PokerRaiseSizes {
  const { pot, callAmount, minBet, maxBet, canBet } = opts;
  const clamp = (raw: bigint): bigint =>
    raw < minBet ? minBet : raw > maxBet ? maxBet : raw;
  const half = clamp(
    callAmount > 0n ? callAmount + (pot + callAmount) / 2n : pot / 2n,
  );
  const full = clamp(callAmount > 0n ? pot + 2n * callAmount : pot);
  const allIn = maxBet;
  return {
    half,
    full,
    allIn,
    showHalf: canBet && half < full && half < allIn,
    showFull: canBet && full < allIn,
    showAllIn: canBet,
  };
}
