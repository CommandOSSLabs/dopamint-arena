import type { ReactNode } from "react";

import {
  Panel,
  PanelAction,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "@/components/ui/panel";
import { RadialGauge } from "@/components/ui/radial-gauge";
import { Segbar } from "@/components/ui/segbar";
import { useBackendStats } from "@/backend/useBackendStats";
import type { TelemetrySnapshot } from "./types";

// Ceiling the bots segbar fills toward (matches the live source's bot range).
const BOT_CAPACITY = 24;

/** Pulsing "LIVE" indicator shown in the panel header. */
function LiveBadge() {
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-success">
      <span className="size-1.5 animate-pulse rounded-full bg-success" />
      LIVE
    </span>
  );
}

/** One labelled mono metric, optionally with a mini-visual beneath it. */
function Stat({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="wal-mono truncate text-sm font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {children}
    </div>
  );
}

/**
 * Key telemetry stats. When the backend SSE feed (GET /v1/stats/live) is
 * configured and live, this surfaces the real global aggregates summed across
 * every client; otherwise it shows this client's local demo telemetry as a
 * radial success gauge + segmented bots bar (patterns from nullframe's
 * Render/Battery cards). The backend is unconfigured in the demo, so the feed
 * is null and the radial/segbar view is what renders.
 */
export function SystemDashboard({
  snapshot,
  className,
}: {
  snapshot: TelemetrySnapshot;
  className?: string;
}) {
  const backend = useBackendStats();

  if (backend) {
    const items = [
      {
        label: "Network TPS",
        value: Math.round(backend.tps).toLocaleString("en-US"),
      },
      {
        label: "Total Actions",
        value: backend.totalActions.toLocaleString("en-US"),
      },
      {
        label: "Active Tunnels",
        value: backend.activeTunnels.toLocaleString("en-US"),
      },
      {
        label: "Settled Tunnels",
        value: backend.settledTunnels.toLocaleString("en-US"),
      },
    ];
    return (
      <Panel className={className}>
        <PanelHeader>
          <PanelTitle>Network (live)</PanelTitle>
          <PanelAction>
            <LiveBadge />
          </PanelAction>
        </PanelHeader>
        <PanelContent className="grid grid-cols-2 gap-3 p-3">
          {items.map((it) => (
            <Stat key={it.label} label={it.label} value={it.value} />
          ))}
        </PanelContent>
      </Panel>
    );
  }

  const bots = snapshot.botsRunning;
  const success = snapshot.successRate;
  // Lit segments of the 10-cell bar; floored at 1 so it never reads empty.
  const botsOn = Math.max(
    1,
    Math.round((Math.min(bots, BOT_CAPACITY) / BOT_CAPACITY) * 10),
  );

  return (
    <Panel className={className}>
      <PanelHeader>
        <PanelTitle>System Dashboard</PanelTitle>
        <PanelAction>
          <LiveBadge />
        </PanelAction>
      </PanelHeader>
      <PanelContent className="flex items-center gap-4 p-3">
        <div className="flex flex-col items-center gap-1">
          <RadialGauge
            value={success / 100}
            display={`${success.toFixed(1)}%`}
          />
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Success
          </span>
        </div>
        <div className="grid flex-1 gap-2.5">
          <Stat label="Bots Running" value={String(bots)}>
            <Segbar total={10} on={botsOn} tone="success" className="mt-1.5" />
          </Stat>
          <Stat
            label="Total Balance"
            value={`$${snapshot.totalBalance.toLocaleString("en-US", {
              minimumFractionDigits: 2,
            })}`}
          />
        </div>
      </PanelContent>
    </Panel>
  );
}
