import type { TelemetrySnapshot } from "./types";
import { Panel } from "./atoms";

export function SystemDashboard({
  snapshot,
}: {
  snapshot: TelemetrySnapshot;
}) {
  const items = [
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
    <Panel title="System Dashboard">
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
