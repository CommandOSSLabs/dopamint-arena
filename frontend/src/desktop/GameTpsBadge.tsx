import { useCallback } from "react";

import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { useSampledRate } from "@/telemetry/useSampledRate";
import { fmtTps } from "@/lib/formatTps";
import { cn } from "@/lib/utils";

/**
 * Per-WINDOW throughput chip for the window header. The number is REAL, never mocked: the local rate
 * of co-signed state updates THIS window's worker is producing, sampled from the per-window counter
 * its scoped report fills (keyed by `windowId`, so two windows of the same game each show their own
 * rate — and {@link useTelemetry}'s `getGamesTotal` still sums them for the aggregate). Both self-play
 * and PvP feed it now (the worker carries its `moves` count in the snapshot).
 *
 * Renders nothing until there is real activity, so the header never shows a placeholder — only a
 * window actually doing work gets a chip.
 */
export function GameTpsBadge({
  windowId,
  className,
}: {
  windowId: string;
  className?: string;
}) {
  const { getGameTotal } = useTelemetry();
  const tps = useSampledRate(
    useCallback(() => getGameTotal(windowId), [getGameTotal, windowId]),
  );
  if (tps == null) return null;

  return (
    <span
      title="This window's TPS (tx/s)"
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
