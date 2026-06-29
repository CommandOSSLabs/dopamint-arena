import {
  Panel,
  PanelAction,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { LiveBadge, OfflineBadge } from "./atoms";

/** One labelled mono metric. Renders a skeleton in place of the value until live data arrives. */
function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {value === null ? (
        <Skeleton className="mt-1 h-5 w-16" />
      ) : (
        <div className="wal-mono truncate text-sm font-semibold tabular-nums text-foreground">
          {value}
        </div>
      )}
    </div>
  );
}

/**
 * Key telemetry stats sourced from the backend SSE feed (GET /v1/stats/live): the real global
 * aggregates summed across every client. Until a live frame arrives the values render as
 * skeletons and the header reads "Offline" — we never fabricate placeholder numbers.
 */
export function SystemDashboard({ className }: { className?: string }) {
  const { backend, status } = useTelemetry();
  const isLive = status === "live" && backend !== null;

  const fmt = (n: number | undefined) =>
    isLive && n !== undefined ? Math.round(n).toLocaleString("en-US") : null;
  const items = [
    { label: "Network TPS", value: fmt(backend?.tps) },
    { label: "Total Actions", value: fmt(backend?.totalActions) },
    { label: "Active Tunnels", value: fmt(backend?.activeTunnels) },
    { label: "Settled Tunnels", value: fmt(backend?.settledTunnels) },
  ];

  return (
    <Panel className={className}>
      <PanelHeader>
        <PanelTitle>System Dashboard</PanelTitle>
        <PanelAction>{isLive ? <LiveBadge /> : <OfflineBadge />}</PanelAction>
      </PanelHeader>
      <PanelContent className="grid grid-cols-2 gap-3 p-3">
        {items.map((it) => (
          <Stat key={it.label} label={it.label} value={it.value} />
        ))}
      </PanelContent>
    </Panel>
  );
}
