import { TransactionsFeed } from "./TransactionsFeed";
import type { TelemetrySnapshot } from "./types";

/** Settled on-chain transactions, with digest/address links to SuiVision. */
export function LiveTransactionsFeed({
  snapshot,
  className,
}: {
  snapshot: TelemetrySnapshot;
  className?: string;
}) {
  return (
    <TransactionsFeed
      title="Live Transactions"
      rows={snapshot.txns}
      onchain
      className={className}
    />
  );
}
