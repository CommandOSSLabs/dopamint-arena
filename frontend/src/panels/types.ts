import type { RateReport } from "sui-tunnel-ts/telemetry/metrics";

export interface TxnRow {
  time: string;
  bot: string;
  type: string;
  status: "Success" | "Failed";
  amount: string;
}

export interface DepositRow {
  time: string;
  method: string;
  amount: string;
  status: "Success" | "Failed";
}

/**
 * The shape every stat panel reads. Today it is a static literal
 * (see ../placeholders.ts). The live source — a worker running the off-chain
 * engine and emitting telemetry — will produce this same shape, so the panels
 * are swap-ready without change. `rate` reuses the SDK's RateReport for fidelity.
 */
export interface TelemetrySnapshot {
  rate: RateReport;
  txns: TxnRow[];
  deposits: DepositRow[];
  /** Recent updates/sec samples for the live sparkline. */
  tpsSeries: number[];
  botsRunning: number;
  totalBalance: number;
  successRate: number;
}
