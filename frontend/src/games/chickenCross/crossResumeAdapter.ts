/**
 * Chicken Cross resume adapter. The state is fully public (no hidden secret — ADR-0010) and moves
 * are JSON-native ({ dirA?, dirB? }), so the only work is bigint (de)serialization: localStorage
 * can't hold bigints, so the five bigint fields round-trip as decimal strings. players/winner are
 * already JSON-native and pass through unchanged.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { JsonValue } from "@/pvp/resume";
import type { CrossState, CrossMove } from "sui-tunnel-ts/protocol/cross";

export function makeCrossResumeAdapter(
  onReconciled?: ResumeAdapter<CrossState, CrossMove>["onReconciled"],
): ResumeAdapter<CrossState, CrossMove> {
  return {
    serializeState: (s) =>
      ({
        tick: s.tick.toString(),
        seed: s.seed.toString(),
        players: s.players,
        winner: s.winner,
        balanceA: s.balanceA.toString(),
        balanceB: s.balanceB.toString(),
        total: s.total.toString(),
      }) as unknown as JsonValue,
    deserializeState: (j) => {
      const o = j as Record<string, unknown>;
      return {
        tick: BigInt(o.tick as string),
        seed: BigInt(o.seed as string),
        players: o.players as CrossState["players"],
        winner: o.winner as CrossState["winner"],
        balanceA: BigInt(o.balanceA as string),
        balanceB: BigInt(o.balanceB as string),
        total: BigInt(o.total as string),
      };
    },
    onReconciled: onReconciled ?? (() => {}),
  };
}
