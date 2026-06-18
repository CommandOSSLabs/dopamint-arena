import { useEffect, useState } from "react";
import { getControlPlaneClient, type StatsSnapshot } from "./controlPlane";

/**
 * Latest global aggregate from the backend's SSE feed (GET /v1/stats/live), or null
 * until the first frame / when the backend is unconfigured. One persistent connection
 * per mount; the server pushes pre-summed figures (~1/s) so the panel never aggregates.
 */
export function useBackendStats(): StatsSnapshot | null {
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null);
  useEffect(() => getControlPlaneClient().openStatsStream(setSnapshot), []);
  return snapshot;
}
