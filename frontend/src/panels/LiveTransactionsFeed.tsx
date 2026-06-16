import type { TelemetrySnapshot } from "./types";
import { Amount, Panel, StatusPill } from "./atoms";

export function LiveTransactionsFeed({
  snapshot,
}: {
  snapshot: TelemetrySnapshot;
}) {
  return (
    <Panel title="Live Transactions Feed">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-arena-panel text-arena-muted">
          <tr>
            <th className="px-3 py-1.5 font-medium">TIME</th>
            <th className="px-3 py-1.5 font-medium">TYPE</th>
            <th className="px-3 py-1.5 font-medium">STATUS</th>
            <th className="px-3 py-1.5 text-right font-medium">AMOUNT</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.txns.map((t, i) => (
            <tr key={i} className="border-t border-arena-edge/50">
              <td className="px-3 py-1.5 text-arena-muted">{t.time}</td>
              <td className="px-3 py-1.5">{t.type}</td>
              <td className="px-3 py-1.5">
                <StatusPill status={t.status} />
              </td>
              <td className="px-3 py-1.5 text-right">
                <Amount value={t.amount} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
