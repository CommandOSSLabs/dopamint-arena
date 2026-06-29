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

/** Locked per seat for the PvP/agent tunnel lane (whole MTPS; see POKER_BUYIN). */
export const QUANTUM_POKER_STAKE = 1000n;

/**
 * Per-seat buy-in, in chips. chips == raw MTPS (1:1), and MTPS is 0-decimal (ADR-0015), so a
 * 1,000-chip buy-in is also 1,000 whole MTPS staked per seat. With POKER_ANTE=1 that's a long
 * session — hundreds of hands before a bust — so a tunnel plays many rounds before settling.
 */
export const POKER_BUYIN = 1000n;

/** Fixed per-hand ante (whole MTPS), passed to the poker protocol. 1 is the smallest unit (the
 *  protocol default is 50), so the 1,000-chip stack lasts many hands. */
export const POKER_ANTE = 1n;
