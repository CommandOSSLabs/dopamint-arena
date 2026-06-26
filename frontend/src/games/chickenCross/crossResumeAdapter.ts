/**
 * Chicken Cross resume adapter. The state is fully public (no hidden secret — ADR-0010) and moves
 * are JSON-native ({ dirA?, dirB? }). `serializeState` passes the state through unchanged; bigint
 * fields (tick/seed/balanceA/balanceB/total) are tagged by `stringifyWithBigint` on persist and
 * revived by `parseWithBigint` on read. players/winner are already JSON-native.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { CrossState, CrossMove } from "sui-tunnel-ts/protocol/cross";

export function makeCrossResumeAdapter(
  onReconciled?: ResumeAdapter<CrossState, CrossMove>["onReconciled"],
): ResumeAdapter<CrossState, CrossMove> {
  return {
    serializeState: (s) =>
      ({
        tick: s.tick,
        seed: s.seed,
        players: s.players,
        winner: s.winner,
        balanceA: s.balanceA,
        balanceB: s.balanceB,
        total: s.total,
      }) as unknown as never,
    deserializeState: (j) => {
      const o = j as Record<string, unknown>;
      return {
        tick: o.tick as bigint,
        seed: o.seed as bigint,
        players: o.players as CrossState["players"],
        winner: o.winner as CrossState["winner"],
        balanceA: o.balanceA as bigint,
        balanceB: o.balanceB as bigint,
        total: o.total as bigint,
      };
    },
    onReconciled: onReconciled ?? (() => {}),
  };
}
