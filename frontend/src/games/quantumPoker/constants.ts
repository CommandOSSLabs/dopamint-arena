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

/** Locked per seat for the PvP/agent tunnel lane. 5000 (was 2500) gives the bots room to bet across
 *  several streets without an early all-in — longer hands, more off-chain actions, and tunnels that
 *  more often reach HAND_CAP before a bust (fewer settle gaps → higher self-play TPS). */
export const QUANTUM_POKER_STAKE = 5000n;

/**
 * Per-seat buy-in for the PvP lane, in chips. chips == raw MTPS (1:1), so this is also the raw
 * stake locked per seat per round. Kept equal to QUANTUM_POKER_STAKE. At 5000 a seat still busts
 * within HAND_CAP at ante 50, but is deep enough to bet across streets (more action before the
 * all-in) instead of shoving on the first raise.
 */
export const POKER_BUYIN = 5000n;
