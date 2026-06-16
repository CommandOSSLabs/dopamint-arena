import type { TelemetrySnapshot } from "./types";
import { Amount, Panel, StatusPill } from "./atoms";

export function RecentDeposits({
  snapshot,
}: {
  snapshot: TelemetrySnapshot;
}) {
  return (
    <Panel title="Recent Deposits">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-arena-panel text-arena-muted">
          <tr>
            <th className="px-3 py-1.5 font-medium">TIME</th>
            <th className="px-3 py-1.5 font-medium">METHOD</th>
            <th className="px-3 py-1.5 text-right font-medium">AMOUNT</th>
            <th className="px-3 py-1.5 font-medium">STATUS</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.deposits.map((d, i) => (
            <tr key={i} className="border-t border-arena-edge/50">
              <td className="px-3 py-1.5 text-arena-muted">{d.time}</td>
              <td className="px-3 py-1.5">{d.method}</td>
              <td className="px-3 py-1.5 text-right">
                <Amount value={d.amount} />
              </td>
              <td className="px-3 py-1.5">
                <StatusPill status={d.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
