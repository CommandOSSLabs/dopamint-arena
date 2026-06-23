/**
 * Blackjack resume adapter. Blackjack state is fully public (no hidden secret) and its moves are
 * JSON-native, so there is no `captureSecret`/`restoreSecret` and no move codec. `serializeState`
 * is a structural pass-through — the bigint balances/round/bet are tagged by `resume.ts` on persist.
 * Asymmetric per-seat buy-ins are recovered from the checkpoint's balance split (the default
 * `balancesFromCheckpoint`), so no separate stake persistence is needed.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type {
  BetBlackjackState,
  BetBlackjackMove,
} from "./app/lib/bjBetProtocol";

export function makeBlackjackResumeAdapter(
  onReconciled: ResumeAdapter<
    BetBlackjackState,
    BetBlackjackMove
  >["onReconciled"],
): ResumeAdapter<BetBlackjackState, BetBlackjackMove> {
  return {
    serializeState: (s) => s as unknown as never,
    deserializeState: (j) => j as BetBlackjackState,
    onReconciled,
  };
}
