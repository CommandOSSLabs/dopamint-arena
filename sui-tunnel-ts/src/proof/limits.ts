/**
 * Canonical per-tunnel move ceiling for ALL games. Entries are fixed-size (state is a
 * 32-byte hash), so one move count governs every game's settle-body size predictably.
 * 100k ≈ 25 MB at the v2 binary entry size (250 B), safely inside the 32 MB /settle cap
 * (~134k capacity). A self-play loop settles + opens a fresh tunnel once it returns true.
 * See docs/superpowers/specs/2026-06-24-settle-binary-transcript-design.md.
 */
export const MAX_MOVES_PER_TUNNEL = 100_000;

export function shouldRotateTunnel(updateCount: number): boolean {
  return updateCount >= MAX_MOVES_PER_TUNNEL;
}
