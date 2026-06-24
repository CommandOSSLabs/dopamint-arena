/**
 * Canonical per-tunnel move ceiling for ALL games. Entries are fixed-size (state is a
 * 32-byte hash), so one move count governs every game's settle-body size predictably.
 * 50k ≈ 12 MB at the v2 binary entry size (~248 B), safely inside the 16 MB /settle cap
 * (~67k capacity). A self-play loop settles + opens a fresh tunnel once it returns true.
 * See docs/superpowers/specs/2026-06-24-settle-binary-transcript-design.md.
 */
export const MAX_MOVES_PER_TUNNEL = 50_000;

export function shouldRotateTunnel(updateCount: number): boolean {
  return updateCount >= MAX_MOVES_PER_TUNNEL;
}
