/**
 * Bomb It resume adapter. State is fully public (no hidden secret — ADR-0010) and moves are
 * JSON-native ({ a?, b? }). `serializeState` passes the state through unchanged; bigint fields
 * (tick/seed/balanceA/balanceB/total) are tagged by `stringifyWithBigint` on persist and revived
 * by `parseWithBigint` on read. The grid round-trips as a plain number[] via Uint8Array.from.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { BombItState, BombItMove } from "sui-tunnel-ts/protocol/bombIt";

export function makeBombItResumeAdapter(
  onReconciled?: ResumeAdapter<BombItState, BombItMove>["onReconciled"],
): ResumeAdapter<BombItState, BombItMove> {
  return {
    serializeState: (s) =>
      ({
        tick: s.tick,
        seed: s.seed,
        grid: Array.from(s.grid),
        players: s.players,
        bombs: s.bombs,
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
        grid: Uint8Array.from(o.grid as number[]),
        players: o.players as BombItState["players"],
        bombs: o.bombs as BombItState["bombs"],
        winner: o.winner as BombItState["winner"],
        balanceA: o.balanceA as bigint,
        balanceB: o.balanceB as bigint,
        total: o.total as bigint,
      };
    },
    onReconciled: onReconciled ?? (() => {}),
  };
}
