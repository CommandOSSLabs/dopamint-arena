/**
 * Bridge the SDK BlackjackProtocol's card VALUES (Ace=11, J/Q/K=10, else face) to
 * display card indices (0..51) understood by the ported CardDisplay, where
 * `index = suit*13 + rankIndex`, suit ∈ clubs/diamonds/hearts/spades,
 * rankIndex 0..12 = A,2..10,J,Q,K.
 *
 * The protocol never stores suit/rank, so faces are COSMETIC: we pick a real rank
 * whose blackjack value equals the protocol value, and a suit, both from a caller
 * `seq` so a hand is stable within a round yet visually varied. Totals stay
 * authoritative because they come from the protocol (mirrored here by handValue).
 */

/** rankIndex -> blackjack value (Ace high = 11; reduced later by handValue). */
export function rankIndexValue(rankIndex: number): number {
  if (rankIndex === 0) return 11; // Ace
  if (rankIndex >= 9) return 10; // 10, J, Q, K
  return rankIndex + 1; // rankIndex 1..8 -> 2..9
}

/** Hand total with soft-ace handling, mirroring protocol/blackjack.ts handValue. */
export function handValue(values: number[]): number {
  let total = 0;
  let aces = 0;
  for (const v of values) {
    total += v;
    if (v === 11) aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

/** rankIndex whose value equals `value`; ten-valued cards vary across 10/J/Q/K by seq. */
function valueToRankIndex(value: number, seq: number): number {
  if (value === 11) return 0; // Ace
  if (value === 10) return 9 + (((seq % 4) + 4) % 4); // 9..12 = 10,J,Q,K
  return value - 1; // 2..9 -> rankIndex 1..8
}

/** Map a protocol value to a display card index 0..51 (suit rotates with seq). */
export function valueToCardIndex(value: number, seq: number): number {
  const suit = ((seq % 4) + 4) % 4;
  return suit * 13 + valueToRankIndex(value, seq);
}

/** Map a hand of values to display indices; `salt` keeps a round's faces stable. */
export function handToCardIndices(values: number[], salt: number): number[] {
  return values.map((v, i) => valueToCardIndex(v, salt * 31 + i * 7));
}
