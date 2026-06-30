/** Target hands per tunnel before cooperative settlement. */
export const QUANTUM_POKER_HAND_CAP = 180n;

/**
 * Hands per tunnel for the in-app Bot/Auto lanes before a cooperative close. The transcript carries
 * one entry per off-chain update (~547 bytes/entry, ~19 entries/hand ≈ 10.4 KB/hand). The backend
 * `/settle` body cap is now 16 MB (RawValue, ~1× in memory), so a tunnel fits up to ~1500 hands
 * before the body overflows (→ 413, silent fallback to a direct close with no Walrus proof). A
 * higher cap means fewer settle gaps and higher self-play TPS, traded against a bigger settle body
 * and a longer cooperative close — the value below is being tuned by benchmark (180 → 800 → 1500).
 */
export const QUANTUM_POKER_HANDS_PER_TUNNEL = 1500n;

/** Per-duel stake (the bet each seat puts in per hand). 500 MTPS per hand. */
export const QUANTUM_POKER_STAKE = 500n;

/**
 * Per-seat buy-in for the solo tunnel lane, in chips. Chips == raw MTPS (0-decimal, 1:1).
 * 500 gives ~500 hands per tunnel before a seat busts — enough for a long auto-play session.
 * Also used by the PvP lane (display + tunnel funding).
 */
export const POKER_BUYIN = 500n;
