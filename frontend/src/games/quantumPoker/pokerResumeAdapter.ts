/**
 * Quantum poker resume adapter. `serializeState` carries ONLY public state — the local-only slot
 * secrets and derived hole cards (`localSecretsA/B`, `holeA/B`) are stripped and round-trip solely
 * through `captureSecret`/`restoreSecret`. Commit/reveal Uint8Array fields are encoded as plain
 * number arrays for JSON. The peer can never supply a seat's own secrets, so restore is
 * local-authoritative.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type {
  PokerState,
  PokerMove,
} from "sui-tunnel-ts/protocol/quantumPoker";
import { pokerMoveCodec } from "sui-tunnel-ts/protocol/quantumPokerCodec";

type PokerSecret = Pick<
  PokerState,
  "localSecretsA" | "localSecretsB" | "holeA" | "holeB"
>;

export function makePokerResumeAdapter(args: {
  getSecret: () => PokerSecret;
  setSecret: (s: PokerSecret) => void;
  onReconciled?: ResumeAdapter<PokerState, PokerMove>["onReconciled"];
}): ResumeAdapter<PokerState, PokerMove> {
  return {
    serializeState: (s) => {
      // Drop local-only secret fields; encode Uint8Array fields as plain arrays.
      const {
        localSecretsA: _a,
        localSecretsB: _b,
        holeA: _ha,
        holeB: _hb,
        ...pub
      } = s as PokerState;
      return JSON.parse(
        JSON.stringify(pub, (_k, v) =>
          v instanceof Uint8Array ? Array.from(v) : v,
        ),
      ) as never;
    },
    // The hook re-hydrates Uint8Arrays where the protocol needs them.
    deserializeState: (j) => j as PokerState,
    serializeMove: (m) => pokerMoveCodec.encode(m) as never,
    deserializeMove: (j) => pokerMoveCodec.decode(j),
    captureSecret: () => args.getSecret() as unknown as never,
    restoreSecret: (j) => args.setSecret(j as PokerSecret),
    onReconciled: args.onReconciled ?? (() => {}),
  };
}
