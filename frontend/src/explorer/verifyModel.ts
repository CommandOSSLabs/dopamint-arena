// Pure mapping from a TranscriptVerification to the four labelled checks the audit seal
// renders. Kept pure so it is unit-tested (the React panel is typecheck-verified).
import type { TranscriptVerification } from "../../../sui-tunnel-ts/src/proof/transcript";

export interface Check {
  key: string;
  label: string;
  ok: boolean;
}

export function checksOf(v: TranscriptVerification): Check[] {
  return [
    {
      key: "sigs",
      label: "Both parties signed every step",
      ok: v.allSigsValid,
    },
    {
      key: "nonce",
      label: "Nonces strictly increasing (no replay)",
      ok: v.nonceMonotonic,
    },
    {
      key: "conserve",
      label: "Balances conserved (no value created)",
      ok: v.balancesConserved,
    },
    {
      key: "root",
      label: "Transcript matches the on-chain anchor",
      ok: v.rootMatches,
    },
  ];
}

export type Verdict = "verified" | "failed" | "unverifiable";

/**
 * Map a verification result to the audit seal. "failed" is reserved for a transcript we COULD
 * check and which did NOT hold — never for a settlement we simply can't check. So we only render a
 * verdict (verified/failed) when there is BOTH an archived transcript AND an on-chain anchored root
 * to check it against; otherwise it is "unverifiable". A transcript with zero signed steps proves
 * nothing (an all-zero root trivially "matches"), so it is unverifiable too — never a green seal.
 */
export function verdictOf(
  v: TranscriptVerification | null,
  hasTranscript: boolean,
  hasAnchoredRoot: boolean,
): Verdict {
  if (!hasTranscript || !hasAnchoredRoot || !v || v.stepCount === 0)
    return "unverifiable";
  return v.ok ? "verified" : "failed";
}
