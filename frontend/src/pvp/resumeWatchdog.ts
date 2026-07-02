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
