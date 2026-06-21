import type { StatsSnapshot } from "./controlPlane";
import type { TxnRow } from "../panels/types";
import { recentEventsToTxnRows } from "./recentEvents";

/** On-chain feed rows: real backend settlements when connected (empty stays empty — the
 *  honesty rule), else the disconnected fallback (local/placeholder). */
export function liveOnchainTxns(
  backend: StatsSnapshot | null,
  fallback: TxnRow[],
): TxnRow[] {
  if (!backend) return fallback;
  return recentEventsToTxnRows(backend.recentEvents ?? []);
}

/** Displayed updates/sec: the backend global aggregate when connected, else the local rate. */
export function displayUpdatesPerSec(
  backend: StatsSnapshot | null,
  localUps: number,
): number {
  return backend ? backend.tps : localUps;
}
