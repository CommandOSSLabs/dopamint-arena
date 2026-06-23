/**
 * Blackjack (bet protocol) resume adapter. Full public state, no hidden secret; the move is
 * JSON-native (`{ action, amount? }`), so move (de)serialization defaults to identity. bigint
 * fields (round/drawIndex/balances/total/bet) are tagged by `resume.ts` on persist.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { BetBlackjackState, BetBlackjackMove } from "./bjBetProtocol";

export function makeBlackjackResumeAdapter(
  onReconciled: ResumeAdapter<
    BetBlackjackState,
    BetBlackjackMove
  >["onReconciled"],
): ResumeAdapter<BetBlackjackState, BetBlackjackMove> {
  return {
    serializeState: (s) => ({ ...s }) as unknown as never,
    deserializeState: (j) => j as BetBlackjackState,
    onReconciled,
  };
}
