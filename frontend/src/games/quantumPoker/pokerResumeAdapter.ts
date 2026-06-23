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
      // Drop local-only secret fields; convert Uint8Array → number[] structurally while
      // PRESERVING bigints (resume.ts tags those on persist — a JSON.stringify here would throw).
      const {
        localSecretsA: _a,
        localSecretsB: _b,
        holeA: _ha,
        holeB: _hb,
        ...pub
      } = s as PokerState;
      return bytesToNumberArrays(pub) as never;
    },
    // The hook re-hydrates Uint8Arrays where the protocol needs them.
    deserializeState: (j) => j as PokerState,
    serializeMove: (m) => pokerMoveCodec.encode(m) as never,
    deserializeMove: (j) => pokerMoveCodec.decode(j),
    // The slot secrets carry Uint8Array value/salt, which localStorage JSON would destroy — encode
    // them as number arrays so the cold-load round-trip is lossless.
    captureSecret: () =>
      ({
        localSecretsA: encodeSlots(args.getSecret().localSecretsA),
        localSecretsB: encodeSlots(args.getSecret().localSecretsB),
        holeA: args.getSecret().holeA,
        holeB: args.getSecret().holeB,
      }) as unknown as never,
    restoreSecret: (j) => {
      const o = j as {
        localSecretsA: EncodedSlot[] | null;
        localSecretsB: EncodedSlot[] | null;
        holeA: number[] | null;
        holeB: number[] | null;
      };
      args.setSecret({
        localSecretsA: decodeSlots(o.localSecretsA),
        localSecretsB: decodeSlots(o.localSecretsB),
        holeA: o.holeA,
        holeB: o.holeB,
      } as PokerSecret);
    },
    onReconciled: args.onReconciled ?? (() => {}),
  };
}

type EncodedSlot = { value: number[]; salt: number[] } | null;

// Recursively turn Uint8Array into number[]; leave bigint/number/string/null/arrays/objects intact.
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

function encodeSlots(arr: PokerSecret["localSecretsA"]): EncodedSlot[] | null {
  if (!arr) return null;
  return arr.map((s) =>
    s ? { value: Array.from(s.value), salt: Array.from(s.salt) } : null,
  );
}

function decodeSlots(arr: EncodedSlot[] | null): PokerSecret["localSecretsA"] {
  if (!arr) return null;
  return arr.map((s) =>
    s
      ? { value: Uint8Array.from(s.value), salt: Uint8Array.from(s.salt) }
      : null,
  );
}
