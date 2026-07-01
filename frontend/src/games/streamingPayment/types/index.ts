export type Screen = "lobby" | "dashboard";

export type SessionPhase =
  | "idle"
  | "creating"
  | "streaming"
  | "toppingUp"
  | "cancelling"
  | "error";

/** True while an on-chain tx is in flight — disable competing actions. */
export function isSessionTxPhase(phase: SessionPhase): boolean {
  return (
    phase === "creating" || phase === "toppingUp" || phase === "cancelling"
  );
}

export type LedgerKind = "create" | "topup" | "cancel" | "complete";

export interface StreamMeta {
  recipientName: string;
  recipientAddress: string;
}

export interface LedgerEntry {
  kind: LedgerKind;
  amount?: bigint;
  /** On-chain tx digest; object id for clock-complete rows without a tx. */
  digest?: string;
  at: number;
}

/** Co-signed streaming.v1 tick — attests cumulative vested amount (no coin move). */
export interface StreamingTick {
  streamId: string;
  tickNonce: number;
  timestampMs: bigint;
  accruedUnlocked: bigint;
}
