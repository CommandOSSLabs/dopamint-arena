/**
 * Blackjack resume adapter (v2 commit-reveal). `serializeState` carries ONLY public state — the
 * local-only commit secrets (`localSecretA/B`, the card pre-images) are stripped and round-trip
 * solely through `captureSecret`/`restoreSecret`, so a persisted checkpoint never stores a seat's
 * undrawn-card secret. Public commit/reveal `Uint8Array` fields are encoded as number arrays for
 * JSON and rehydrated on load. Moves cross the resume record through `bjMoveCodec`, which also
 * drops the pre-image. The peer can never supply a seat's own secret, so restore is
 * local-authoritative.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type {
  BetBlackjackMove,
  BetBlackjackState,
} from "./app/lib/bjBetProtocol";
import { bjMoveCodec } from "./app/lib/bjMoveCodec";

type BlackjackSecret = Pick<BetBlackjackState, "localSecretA" | "localSecretB">;

export function makeBlackjackResumeAdapter(args: {
  getSecret: () => BlackjackSecret;
  setSecret: (s: BlackjackSecret) => void;
  onReconciled: ResumeAdapter<
    BetBlackjackState,
    BetBlackjackMove
  >["onReconciled"];
}): ResumeAdapter<BetBlackjackState, BetBlackjackMove> {
  return {
    serializeState: (s) => {
      // Drop local-only secrets; convert Uint8Array → number[] structurally while PRESERVING
      // bigints (resume.ts tags those on persist — a JSON.stringify here would throw).
      const { localSecretA: _a, localSecretB: _b, ...pub } = s;
      return bytesToNumberArrays(pub) as never;
    },
    deserializeState: (j) => rehydrateState(j as Record<string, unknown>),
    serializeMove: (m) => bjMoveCodec.encode(m) as never,
    deserializeMove: (j) => bjMoveCodec.decode(j),
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
      });
    },
    onReconciled: args.onReconciled,
  };
}

type EncodedSecret = { value: number[]; salt: number[] } | null;

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

/** Rebuild the public Uint8Array fields the protocol needs from their JSON number-array form. */
function rehydrateState(o: Record<string, unknown>): BetBlackjackState {
  const toBytes = (v: unknown): Uint8Array | null =>
    Array.isArray(v) ? Uint8Array.from(v as number[]) : null;
  const toReveal = (v: unknown) => {
    if (!v || typeof v !== "object") return null;
    const r = v as { value: number[]; salt: number[] };
    return { value: Uint8Array.from(r.value), salt: Uint8Array.from(r.salt) };
  };
  return {
    ...(o as unknown as BetBlackjackState),
    pendingCommitA: toBytes(o.pendingCommitA),
    pendingCommitB: toBytes(o.pendingCommitB),
    pendingRevealA: toReveal(o.pendingRevealA),
    pendingRevealB: toReveal(o.pendingRevealB),
    // Secrets are never in the public state; restoreSecret repopulates them.
    localSecretA: null,
    localSecretB: null,
  };
}

function encodeSecret(s: BetBlackjackState["localSecretA"]): EncodedSecret {
  return s ? { value: Array.from(s.value), salt: Array.from(s.salt) } : null;
}

function decodeSecret(s: EncodedSecret): BetBlackjackState["localSecretA"] {
  return s
    ? { value: Uint8Array.from(s.value), salt: Uint8Array.from(s.salt) }
    : null;
}
