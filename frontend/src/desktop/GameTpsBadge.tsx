import { useCallback } from "react";

import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { useSampledRate } from "@/telemetry/useSampledRate";
import { fmtTps } from "@/lib/formatTps";
import { cn } from "@/lib/utils";

/**
 * Per-game throughput chip for the window header. The number is REAL, never mocked:
 *   - while the backend stats feed is live, the backend's authoritative per-game rate
 *     (`StatsSnapshot.perGame[gameId].tps`, ADR-0002 — the backend owns the rate);
 *   - otherwise (offline / self-play demo), the actual rate of co-signed updates this
 *     game is producing, sampled from the per-game counter the game's scoped report fills.
 *
 * Renders nothing until there is real activity to show, so the header never displays a
 * placeholder — only a game that is actually doing work gets a chip.
 */
export function GameTpsBadge({
  gameId,
  className,
}: {
  gameId: string;
  className?: string;
}) {
  const { backend, getGameTotal } = useTelemetry();
  const backendTps = backend?.perGame?.[gameId]?.tps;
  // Local fallback: instantaneous updates/sec from this game's counter (authoritative backend
  // rate wins when present).
  const localTps = useSampledRate(
    useCallback(() => getGameTotal(gameId), [getGameTotal, gameId]),
  );

  const tps = backendTps ?? localTps;
  if (tps == null) return null;

  return (
    <span
      title="Your TPS (tx/s)"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-primary",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-1.5 animate-pulse rounded-full bg-primary"
      />
      {fmtTps(tps)} TPS
    </span>
  );
}
