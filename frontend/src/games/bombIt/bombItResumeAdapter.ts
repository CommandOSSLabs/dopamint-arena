/**
 * Bomb It resume adapter. State is fully public (no hidden secret — ADR-0010) and moves are
 * JSON-native ({ a?, b? }). localStorage holds neither bigints nor typed arrays, so the five bigint
 * fields round-trip as decimal strings and the grid round-trips as a plain number[]. players/bombs
 * are already JSON-native.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { JsonValue } from "@/pvp/resume";
import type { BombItState, BombItMove } from "sui-tunnel-ts/protocol/bombIt";

export function makeBombItResumeAdapter(
  onReconciled?: ResumeAdapter<BombItState, BombItMove>["onReconciled"],
): ResumeAdapter<BombItState, BombItMove> {
  return {
    serializeState: (s) =>
      ({
        tick: s.tick.toString(),
        seed: s.seed.toString(),
        grid: Array.from(s.grid),
        players: s.players,
        bombs: s.bombs,
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
        grid: Uint8Array.from(o.grid as number[]),
        players: o.players as BombItState["players"],
        bombs: o.bombs as BombItState["bombs"],
        winner: o.winner as BombItState["winner"],
        balanceA: BigInt(o.balanceA as string),
        balanceB: BigInt(o.balanceB as string),
        total: BigInt(o.total as string),
      };
    },
    onReconciled: onReconciled ?? (() => {}),
  };
}
