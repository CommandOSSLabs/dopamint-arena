/**
 * Resume reconciliation decision table (pure). Given each seat's latest co-signed nonce, whether
 * it holds an in-flight proposal, and its checkpoint, decide the single action that converges the
 * two seats. A drop leaves them AT MOST one move apart (a seat cannot propose nonce N+2 while N+1
 * is pending), so these five cases are exhaustive. Verification is NOT done here — the caller
 * verifies the peer's checkpoint inside `DistributedTunnel.adoptCheckpoint` when acting on "adopt".
 */
import { bytesEqual } from "./bytes";
import { CoSignedUpdate } from "./tunnel";

export type ReconcileAction =
  | "adopt"
  | "wait"
  | "re-propose"
  | "noop"
  | "settle";
export interface ReconcileDecision {
  action: ReconcileAction;
}

/** One seat's view exchanged in a `resync`. `checkpoint` is its highest both-signed update. */
export interface ResyncView {
  nonce: bigint;
  hasPending: boolean;
  checkpoint: CoSignedUpdate | null;
}

/**
 * Decide what THIS seat (`self`) should do given the peer's resync view.
 *  - peer ahead            -> "adopt"      (adopt peer's checkpoint+state; clears my pending)
 *  - self ahead            -> "wait"       (my resync lets the peer adopt; nothing for me to do)
 *  - equal, conflicting    -> "settle"     (equivocation: different both-signed state at one nonce)
 *  - equal, self pending   -> "re-propose" (re-send my in-flight MOVE through the normal transport)
 *  - equal, no pending     -> "noop"       (already converged; resume play)
 */
export function decideReconcile(
  self: ResyncView,
  peer: ResyncView
): ReconcileDecision {
  if (peer.nonce > self.nonce) return { action: "adopt" };
  if (self.nonce > peer.nonce) return { action: "wait" };
  if (
    self.checkpoint &&
    peer.checkpoint &&
    !bytesEqual(
      self.checkpoint.update.stateHash,
      peer.checkpoint.update.stateHash
    )
  ) {
    return { action: "settle" };
  }
  if (self.hasPending) return { action: "re-propose" };
  return { action: "noop" };
}
