/**
 * Blackjack resume adapter. `serializeState` carries ONLY public state — the local-only seat
 * secrets (`localSecretA/B`) are stripped and round-trip solely through `captureSecret`/
 * `restoreSecret`. Commit/reveal Uint8Array move fields go through `blackjackMoveCodec`.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type {
  BlackjackState,
  BlackjackMove,
  BlackjackSlotSecret,
} from "sui-tunnel-ts/protocol/blackjack";
import { blackjackMoveCodec } from "sui-tunnel-ts/protocol/blackjackCodec";

type BlackjackSecret = Pick<BlackjackState, "localSecretA" | "localSecretB">;
type EncodedSecret = { value: number[]; salt: number[] } | null;

export function makeBlackjackResumeAdapter(args: {
  getSecret: () => BlackjackSecret;
  setSecret: (s: BlackjackSecret) => void;
  onReconciled?: ResumeAdapter<BlackjackState, BlackjackMove>["onReconciled"];
}): ResumeAdapter<BlackjackState, BlackjackMove> {
  return {
    serializeState: (s) => {
      const {
        localSecretA: _a,
        localSecretB: _b,
        ...pub
      } = s as BlackjackState;
      return bytesToNumberArrays(pub) as never;
    },
    deserializeState: (j) => j as BlackjackState,
    serializeMove: (m) => blackjackMoveCodec.encode(m) as never,
    deserializeMove: (j) => blackjackMoveCodec.decode(j),
    captureSecret: () =>
      ({
        localSecretA: encodeSecret(args.getSecret().localSecretA),
        localSecretB: encodeSecret(args.getSecret().localSecretB),
      }) as unknown as never,
    restoreSecret: (j) => {
      const o = j as {
        localSecretA: EncodedSecret;
        localSecretB: EncodedSecret;
      };
      args.setSecret({
        localSecretA: decodeSecret(o.localSecretA),
        localSecretB: decodeSecret(o.localSecretB),
      } as BlackjackSecret);
    },
    onReconciled: args.onReconciled ?? (() => {}),
  };
}

function bytesToNumberArrays(v: unknown): unknown {
  if (v instanceof Uint8Array) return Array.from(v);
  if (Array.isArray(v)) return v.map(bytesToNumberArrays);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = bytesToNumberArrays(val);
    return out;
  }
  return v;
}

function encodeSecret(s: BlackjackSlotSecret | null): EncodedSecret {
  return s ? { value: Array.from(s.value), salt: Array.from(s.salt) } : null;
}

function decodeSecret(s: EncodedSecret): BlackjackSlotSecret | null {
  return s
    ? { value: Uint8Array.from(s.value), salt: Uint8Array.from(s.salt) }
    : null;
}
