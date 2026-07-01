export type Screen = "lobby" | "dashboard";

export type SessionPhase =
  | "idle"
  | "deploying"
  | "active"
  | "claiming"
  | "pausing"
  | "resuming"
  | "revoking";

/** True while an on-chain tx is in flight — disable competing actions. */
export function isSessionTxPhase(phase: SessionPhase): boolean {
  return (
    phase === "deploying" ||
    phase === "claiming" ||
    phase === "pausing" ||
    phase === "resuming" ||
    phase === "revoking"
  );
}

export type LedgerKind = "create" | "pull" | "pause" | "resume" | "revoke";

export interface MandateMeta {
  agentName: string;
  providerName: string;
}

export interface LedgerEntry {
  kind: LedgerKind;
  amount?: bigint;
  digest: string;
  at: number;
}
