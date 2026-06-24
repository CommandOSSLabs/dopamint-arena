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

/** Locked per seat for the PvP/agent tunnel lane. */
export const QUANTUM_POKER_STAKE = 2500n;

/**
 * Per-seat buy-in for the PvP lane, in chips. chips == raw DOPAMINT (1:1), so this is also the raw
 * stake locked per seat per round. "1 DOPAMINT = 2500 chips" is the UI label; the on-chain stake is
 * this many raw units. Sized so a seat busts (and auto-rebuys) within HAND_CAP at ante 50.
 */
export const POKER_BUYIN = 2500n;
