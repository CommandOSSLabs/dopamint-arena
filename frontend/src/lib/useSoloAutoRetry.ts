import { useEffect } from "react";

/**
 * Re-attempt a failed solo start on a fixed interval while the session sits in
 * "error". Recovers a transient funding failure — a cold-start MTPS faucet
 * race or a brief gas-sponsor outage — without the player touching anything, so
 * the unattended bot game heals itself. Inert unless `enabled` and the status is
 * "error"; the interval is torn down the moment the session leaves "error" (the
 * retry having moved it to "funding"), so a successful attempt stops the loop.
 *
 * `retry` should reset the session to idle and start it again; pass it stable
 * (useCallback) so the interval isn't rebuilt every render.
 */
export function useSoloAutoRetry(
  enabled: boolean,
  status: string,
  retry: () => void,
  intervalMs = 5000,
): void {
  useEffect(() => {
    if (!enabled || status !== "error") return;
    const id = setInterval(retry, intervalMs);
    return () => clearInterval(id);
  }, [enabled, status, retry, intervalMs]);
}
