import { Panel } from "@/components/ui/panel";
import type { BackendStats } from "@/backend/useBackendStats";
import { formatCount } from "@/lib/utils";

export function MetricsStrip({ snapshot, status }: BackendStats) {
  const s = status === "live" ? snapshot : null;
  // `accent` marks the throughput headline (the demo centerpiece): a violet value + a gradient
  // hairline, so the eye lands on TPS before the supporting counts.
  const cards = [
    { label: "Current TPS", value: s?.tps, accent: true },
    { label: "Peak TPS", value: s?.peakTps, accent: true },
    { label: "Open tunnels", value: s?.activeTunnels, accent: false },
    { label: "Total transactions", value: s?.totalActions, accent: false },
    { label: "Total tunnels", value: s?.settledTunnels, accent: false },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 duration-500 animate-in fade-in sm:grid-cols-5">
      {cards.map(({ label, value, accent }) => (
        <Panel
          key={label}
          className="relative gap-1 p-3 transition-colors hover:border-primary/40"
        >
          {accent && (
            <span className="absolute inset-x-0 top-0 h-0.5 [background-image:var(--wal-grad-memory)]" />
          )}
          <span className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          <span
            className={`wal-mono truncate text-lg font-semibold tabular-nums ${
              accent ? "text-primary" : "text-foreground"
            }`}
          >
            {formatCount(value)}
          </span>
        </Panel>
      ))}
    </div>
  );
}
