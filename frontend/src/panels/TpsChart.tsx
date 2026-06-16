import type { TelemetrySnapshot } from "./types";
import { Panel } from "./atoms";

/** Headline updates/sec plus a dependency-free SVG sparkline of recent samples. */
export function TpsChart({ snapshot }: { snapshot: TelemetrySnapshot }) {
  const series = snapshot.tpsSeries;
  const max = Math.max(1, ...series);
  const n = series.length;
  const points = series
    .map((v, i) => {
      const x = n > 1 ? (i / (n - 1)) * 100 : 0;
      const y = 30 - (v / max) * 28 - 1;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <Panel title="Transactions / sec (Live)">
      <div className="p-3">
        <div className="text-2xl font-semibold text-arena-accent">
          {Math.round(snapshot.rate.updatesPerSec).toLocaleString("en-US")}
        </div>
        <svg
          viewBox="0 0 100 30"
          preserveAspectRatio="none"
          className="mt-2 h-24 w-full text-arena-accent"
        >
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    </Panel>
  );
}
