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

/**
 * Evaluates whether a new episode (e.g., a hand of poker, a round of blackjack, or one
 * game in a series) can safely run to completion without hitting the hard
 * MAX_MOVES_PER_TUNNEL limit mid-game. Called at natural episode boundaries to decide if
 * we should settle and rotate early.
 *
 * The unifying invariant: every game measures the SAME quantity — the number of co-signed
 * tunnel updates — against MAX_MOVES_PER_TUNNEL. Only where that count is read differs, and
 * it follows the driver, not the game:
 *   - Games driven by the generic PvP engine (which stops on `protocol.isTerminal`) fold the
 *     count into protocol state and let isTerminal own the decision (grid `totalMoves`,
 *     world-canvas `updates`).
 *   - Games driven by a bespoke hook read the tunnel's `nonce` directly at a phase boundary
 *     (blackjack round, poker hand, chat exchange).
 * Both feed `updateCount` here; `expectedMaxMoves` is that episode's worst-case update budget.
 * Finite games (grid/card) also terminate naturally via maxGames/bankruptcy, so this is their
 * secondary safety belt; open-ended games (chat) have no natural terminal, so it is their only
 * stop rule.
 */
export function canSafelyPlayNextEpisode(
  updateCount: number,
  expectedMaxMoves: number
): boolean {
  return updateCount + expectedMaxMoves < MAX_MOVES_PER_TUNNEL;
}
