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
    { key: "sigs", label: "Both parties signed every step", ok: v.allSigsValid },
    { key: "nonce", label: "Nonces strictly increasing (no replay)", ok: v.nonceMonotonic },
    { key: "conserve", label: "Balances conserved (no value created)", ok: v.balancesConserved },
    { key: "root", label: "Transcript matches the on-chain anchor", ok: v.rootMatches },
  ];
}

export type Verdict = "verified" | "failed" | "unverifiable";

export function verdictOf(v: TranscriptVerification | null, hasTranscript: boolean): Verdict {
  if (!hasTranscript) return "unverifiable";
  return v && v.ok ? "verified" : "failed";
}
