/**
 * Tic-tac-toe / caro resume adapter. Full public state with no hidden secret; the move is
 * JSON-native (`{ cell, salt }`), so move (de)serialization defaults to identity. bigint
 * balances are tagged by `resume.ts` on persist, so `serializeState` is a plain pass-through.
 *
 * `deserializeState` reconstructs `inner.moveAccumulator` as a `Uint8Array` because the v2
 * protocol stores it as a typed array in the live state but JSON round-trips lose the type.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { JsonValue } from "@/pvp/resume";

// AnyState/CellMove mirror the hook's tunnel generics (board/turn/winner/balances + gamesPlayed).
export function makeTttResumeAdapter<AnyState, CellMove>(
  onReconciled: ResumeAdapter<AnyState, CellMove>["onReconciled"],
): ResumeAdapter<AnyState, CellMove> {
  return {
    serializeState: (s) => s as unknown as JsonValue,
    deserializeState: (j) => {
      const raw = j as Record<string, unknown>;
      const inner = raw.inner as Record<string, unknown> | undefined;
      if (inner && inner.moveAccumulator !== undefined) {
        // JSON serialises Uint8Array as a plain object {"0":0,"1":1,...}.
        // Rebuild the typed array so encodeState / adoptCheckpoint work correctly.
        const acc = inner.moveAccumulator as Record<string, number> | Uint8Array;
        if (!(acc instanceof Uint8Array)) {
          const keys = Object.keys(acc).filter((k) => !isNaN(Number(k)));
          const bytes = new Uint8Array(keys.length);
          for (const k of keys) bytes[Number(k)] = (acc as Record<string, number>)[k]!;
          inner.moveAccumulator = bytes;
        }
      }
      return raw as AnyState;
    },
    onReconciled,
  };
}
