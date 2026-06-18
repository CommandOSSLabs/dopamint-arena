import type { TelemetrySnapshot } from "./types";
import type { StatsSnapshot } from "../backend/controlPlane";
import { Panel } from "./atoms";

export function SystemDashboard({
  snapshot,
  backend,
}: {
  snapshot: TelemetrySnapshot;
  backend?: StatsSnapshot | null;
}) {
  // When the backend SSE feed is live, surface its real global aggregates (summed across
  // every client, incl. the throughput fleet); otherwise fall back to this client's local
  // self-play counters.
  const items = backend
    ? [
        { label: "Network TPS", value: Math.round(backend.tps).toLocaleString("en-US") },
        { label: "Total Actions", value: backend.totalActions.toLocaleString("en-US") },
        { label: "Active Tunnels", value: backend.activeTunnels.toLocaleString("en-US") },
        { label: "Settled Tunnels", value: backend.settledTunnels.toLocaleString("en-US") },
      ]
    : [
        { label: "Bots Running", value: String(snapshot.botsRunning) },
        {
          label: "Total Balance",
          value: `$${snapshot.totalBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
        },
        {
          label: "Avg Transactions / sec",
          value: Math.round(snapshot.rate.updatesPerSec).toLocaleString("en-US"),
        },
        { label: "Success Rate", value: `${snapshot.successRate}%` },
      ];

  return (
    <Panel title={backend ? "Network Dashboard (live)" : "System Dashboard"}>
      <dl className="grid grid-cols-2 gap-px bg-arena-edge">
        {items.map((it) => (
          <div key={it.label} className="bg-arena-panel p-3">
            <dt className="text-[11px] text-arena-muted">{it.label}</dt>
            <dd className="mt-1 text-lg font-semibold text-arena-text">
              {it.value}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
