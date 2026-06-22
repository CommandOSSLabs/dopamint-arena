/**
 * Battleship resume adapter. `serializeState` carries ONLY public state (the merkle commits as
 * plain number arrays); the hidden fleet — board + per-cell salts — round-trips solely through
 * `captureSecret`/`restoreSecret`, never the wire-bound resync/persisted state. That separation is
 * why local-authoritative restore was chosen: the peer can never supply a seat's own fleet secret.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import {
  battleshipMoveCodec,
  type BattleshipState,
  type BattleshipMove,
} from "./protocol/battleship";
import type { FleetSecret } from "./engine/selfPlay";

export function makeBattleshipResumeAdapter(args: {
  getSecret: () => FleetSecret;
  setSecret: (s: FleetSecret) => void;
  onReconciled?: ResumeAdapter<BattleshipState, BattleshipMove>["onReconciled"];
}): ResumeAdapter<BattleshipState, BattleshipMove> {
  return {
    // Public state only; commits are Uint8Array → plain number arrays.
    serializeState: (s) =>
      ({
        ...s,
        commitA: s.commitA ? Array.from(s.commitA) : null,
        commitB: s.commitB ? Array.from(s.commitB) : null,
      }) as unknown as never,
    deserializeState: (j) => {
      const o = j as Record<string, unknown>;
      return {
        ...(o as object),
        commitA: o.commitA ? Uint8Array.from(o.commitA as number[]) : null,
        commitB: o.commitB ? Uint8Array.from(o.commitB as number[]) : null,
      } as BattleshipState;
    },
    serializeMove: (m) => battleshipMoveCodec.encode(m) as never,
    deserializeMove: (j) => battleshipMoveCodec.decode(j),
    // Fleet (board + salts + commitment) — NEVER in serializeState.
    captureSecret: () => args.getSecret() as unknown as never,
    restoreSecret: (j) => args.setSecret(j as FleetSecret),
    onReconciled: args.onReconciled ?? (() => {}),
  };
}
