/** Target hands per tunnel before cooperative settlement. */
export const QUANTUM_POKER_HAND_CAP = 180n;

/**
 * Hands per tunnel for the in-app Bot/Auto lanes before a cooperative close. Sized to fill — but
 * stay under — the backend `/settle` 2MB body limit (axum's Json default, kept intentionally small
 * so every game's per-tunnel transcript stays bounded). The transcript carries one entry per
 * off-chain update (~547 bytes/entry, ~19 entries/hand); the `/settle` body peaks ~1.82MB at 180
 * hands (~9% margin) across seeds/personas. 200 hands overflows (~2.05MB → 413, silent fallback to
 * a direct close with no Walrus proof). Keep this ≤ ~185; do NOT raise the backend body limit.
 */
export const QUANTUM_POKER_HANDS_PER_TUNNEL = 180n;

/** Locked per seat for the PvP/agent tunnel lane. */
export const QUANTUM_POKER_STAKE = 2500n;

/**
 * Per-seat buy-in for the PvP lane, in chips. chips == raw DOPAMINT (1:1), so this is also the raw
 * stake locked per seat per round. "1 DOPAMINT = 2500 chips" is the UI label; the on-chain stake is
 * this many raw units. Sized so a seat busts (and auto-rebuys) within HAND_CAP at ante 50.
 */
export const POKER_BUYIN = 2500n;
