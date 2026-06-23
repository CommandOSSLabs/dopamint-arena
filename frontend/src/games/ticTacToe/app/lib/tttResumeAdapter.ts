/**
 * Tic-tac-toe / caro resume adapter. Full public state with no hidden secret; the move is
 * JSON-native (`{ cell }`), so move (de)serialization defaults to identity. bigint balances are
 * tagged by `resume.ts` on persist, so `serializeState` is a plain structural pass-through.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";

// AnyState/CellMove mirror the hook's tunnel generics (board/turn/winner/balances + gamesPlayed).
export function makeTttResumeAdapter<AnyState, CellMove>(
  onReconciled: ResumeAdapter<AnyState, CellMove>["onReconciled"],
): ResumeAdapter<AnyState, CellMove> {
  return {
    serializeState: (s) => s as unknown as never,
    deserializeState: (j) => j as AnyState,
    onReconciled,
  };
}
