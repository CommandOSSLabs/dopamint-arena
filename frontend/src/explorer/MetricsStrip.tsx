import { Panel } from "@/components/ui/panel";
import { useBackendStats } from "@/backend/useBackendStats";

const fmt = (n: number | undefined) => (n == null ? "—" : n.toLocaleString());

export function MetricsStrip() {
  const { snapshot, status } = useBackendStats();
  const s = status === "live" ? snapshot : null;
  const cards = [
    ["Current TPS", s?.tps],
    ["Peak TPS", s?.peakTps],
    ["Open tunnels", s?.activeTunnels],
    ["Total transactions", s?.totalActions],
    ["Total tunnels", s?.settledTunnels],
  ] as const;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {cards.map(([label, value]) => (
        <Panel key={label} className="flex flex-col gap-1 p-3">
          <span className="wal-eyebrow text-muted-foreground">{label}</span>
          <span className="wal-mono text-lg">{fmt(value)}</span>
        </Panel>
      ))}
    </div>
  );
}
