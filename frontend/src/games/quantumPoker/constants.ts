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

/** Per-hand bet unit fed to the bots (display/sanity only; the protocol's `ante` drives real bets). */
export const QUANTUM_POKER_STAKE = 1n;

/**
 * The fixed per-hand wager unit (`ante`) passed to `QuantumPokerProtocol`. THIS is what each hand
 * actually risks — the default 50 made every hand a huge bet against a small buy-in, so it's scaled
 * to 1 chip for the whole-token (0-decimal) economy. The buy-in below must be ≥ this (a seat posts
 * one ante to be dealt in). */
export const POKER_ANTE = 1n;

/**
 * Per-seat buy-in (chip stack) for the tunnel lane, in chips. Chips == raw MTPS (0-decimal, 1:1).
 * The on-chain bank the engine funds per seat — the smallest sensible value: ~10 antes deep, so a
 * tunnel opens cheap and a seat plays many small hands (the hand cap, not busting, bounds the match).
 * Floor is {@link POKER_ANTE} (a seat needs ≥ one ante to be dealt in). Used by solo + PvP lanes.
 */
export const POKER_BUYIN = 10n;
