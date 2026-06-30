/** Target hands per tunnel before cooperative settlement. */
export const QUANTUM_POKER_HAND_CAP = 180n;

/**
 * Hands per tunnel for the in-app Bot/Auto lanes before a cooperative close. The transcript carries
 * one fixed 250 B entry per off-chain update (~19 updates/hand ≈ 4.75 KB/hand; the hand state is
 * hashed into the 32-byte stateHash, never in the message). The backend `/settle` body cap is 32 MB,
 * so a tunnel fits ~7000 hands before overflow (→ 413, silent fallback to a direct close with no
 * Walrus proof); 2500 leaves a wide margin (~12 MB, ~35%). A higher cap means fewer settle gaps and
 * higher self-play TPS, traded against a bigger settle body and a longer cooperative close — being
 * tuned by benchmark (180 → 800 → 1500 → 2500).
 */
export const QUANTUM_POKER_HANDS_PER_TUNNEL = 2500n;

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
