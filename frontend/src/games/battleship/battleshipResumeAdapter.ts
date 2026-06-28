/**
 * Battleship resume adapter. `serializeState` carries ONLY public state (the board commitments as
 * plain number arrays); the hidden fleet — board + single salt — round-trips solely through
 * `captureSecret`/`restoreSecret`, never the wire-bound resync/persisted state. That separation is
 * why local-authoritative restore was chosen: the peer can never supply a seat's own fleet secret.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import { battleshipMoveCodec } from "sui-tunnel-ts/protocol/battleshipCodec";
import type {
  BattleshipState,
  BattleshipMove,
} from "sui-tunnel-ts/protocol/battleship";
import { makeFleetSecret, type FleetSecret } from "./engine/selfPlay";
import type { Placement } from "./engine/fleet";

export function makeBattleshipResumeAdapter(args: {
  getSecret: () => FleetSecret;
  setSecret: (s: FleetSecret) => void;
  getPlacements: () => Placement[];
  setPlacements: (p: Placement[]) => void;
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
    // Fleet (board + salt) AND placements — NEVER in serializeState. Stored JSON-safe (typed
    // arrays → number arrays so they survive localStorage); the commitment is recomputed from
    // board+salt on restore, and placements ride along because they're not derivable from the board.
    captureSecret: () => {
      const fleet = args.getSecret();
      return {
        fleet: {
          board: Array.from(fleet.board),
          salt: Array.from(fleet.salt),
        },
        placements: args.getPlacements(),
      } as unknown as never;
    },
    restoreSecret: (j) => {
      const o = j as {
        fleet: { board: number[]; salt: number[] };
        placements: Placement[];
      };
      args.setSecret(
        makeFleetSecret(
          Uint8Array.from(o.fleet.board),
          Uint8Array.from(o.fleet.salt),
        ),
      );
      args.setPlacements(o.placements);
    },
    onReconciled: args.onReconciled ?? (() => {}),
  };
}
