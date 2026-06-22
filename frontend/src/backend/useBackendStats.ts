import { useEffect, useState } from "react";
import { getControlPlaneClient, type StatsSnapshot } from "./controlPlane";

/** SSE lifecycle: `connecting` until the first frame arrives, `live` once data flows, and
 *  `offline` only if the connection errors before any frame. Distinguishing these lets the
 *  dashboard show a quiet (empty) shell while connecting and reserve the demo fallback for a
 *  backend that is genuinely down — instead of flashing fake data on every refresh. */
export type BackendStatus = "connecting" | "live" | "offline";

export interface BackendStats {
  snapshot: StatsSnapshot | null;
  status: BackendStatus;
}

/**
 * Latest global aggregate from the backend's SSE feed (GET /v1/stats/live), plus the
 * connection status. One persistent connection per mount; the server pushes pre-summed
 * figures (~1/s) so the panel never aggregates.
 */
export function useBackendStats(): BackendStats {
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null);
  const [status, setStatus] = useState<BackendStatus>("connecting");
  useEffect(
    () =>
      getControlPlaneClient().openStatsStream({
        onSnapshot: (s) => {
          setSnapshot(s);
          setStatus("live");
        },
        // A drop after we've gone live is a transient reconnect — keep showing the last
        // data; only an error before the first frame means the backend is unreachable.
        onError: () => setStatus((cur) => (cur === "live" ? cur : "offline")),
      }),
    [],
  );
  return { snapshot, status };
}
