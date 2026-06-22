/** Target hands per tunnel before cooperative settlement. */
export const QUANTUM_POKER_HAND_CAP = 1000n;

/**
 * Hands per tunnel for the in-app Bot/Auto lanes before a cooperative close. Deliberately small:
 * the settlement transcript carries ONE entry per off-chain update (~25/hand), and the backend
 * `/settle` (which uploads the proof to Walrus and emits the LIVE-TRANSACTIONS "settled" event)
 * rejects bodies over ~2MB. At 1000 hands the ~15MB transcript 413s and the close silently falls
 * back to a direct on-chain close — no Walrus, no settled event. Settling every ~50 hands keeps
 * each transcript under the limit (~1MB), so the proof archives and the close shows up on-chain.
 */
export const QUANTUM_POKER_HANDS_PER_TUNNEL = 50n;

/** Locked per seat for the PvP/agent tunnel lane. */
export const QUANTUM_POKER_STAKE = 10_000n;
