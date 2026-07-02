/** How long a just-resumed match waits on the peer before the watchdog gives up and drops to the
 *  lobby. Short (not the 1h on-chain grace): resume convergence is a handshake round-trip, so a peer
 *  that hasn't replied in this window is gone (bot exited, or a reconnect our resync can't reach) and
 *  the user should get their lobby back rather than stare at a stuck board. Shared by the main-thread
 *  hook and the worker session so both bound resume identically. */
export const RESUME_WATCHDOG_MS = 10_000;

/**
 * Whether a just-resumed match should arm the peer-timeout watchdog. Arm ONLY when we're actually
 * waiting on the peer to advance — an unacked move we just re-sent, or it's the peer's turn. A clean
 * resume on our OWN turn already succeeded (the user simply makes their move next), so arming there
 * would tear a healthy match down: the watchdog's job is to catch a peer that never answers (a
 * co-located bot that exited past its grace, or a cross-instance reconnect our resync can't reach),
 * not to police a match that resumed fine.
 */
export function resumeWatchdogShouldArm(
  hasPendingMove: boolean,
  isPeersTurn: boolean,
): boolean {
  return hasPendingMove || isPeersTurn;
}
