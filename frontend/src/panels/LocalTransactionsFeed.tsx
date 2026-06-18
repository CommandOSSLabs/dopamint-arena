import { TransactionsFeed } from "./TransactionsFeed";
import type { TelemetrySnapshot } from "./types";

/**
 * Off-chain tunnel moves co-signed locally but not yet settled on-chain — the
 * same feed as Live Transactions minus the digest/address columns (those exist
 * only once a move settles).
 */
export function LocalTransactionsFeed({
  snapshot,
  className,
}: {
  snapshot: TelemetrySnapshot;
  className?: string;
}) {
  return (
    <TransactionsFeed
      title="My Activity"
      rows={snapshot.localTxns}
      className={className}
    />
  );
}
