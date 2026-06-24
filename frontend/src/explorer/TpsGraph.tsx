import { useState } from "react";
import { Panel, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { useTpsHistory, type TpsPoint } from "@/backend/useTpsHistory";

const WINDOWS = [
  ["15m", 900],
  ["1h", 3600],
  ["6h", 21600],
] as const;

function path(points: TpsPoint[], w: number, h: number): string {
  if (points.length < 2) return "";
  const xs = points.map((p) => p.t);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    maxV = Math.max(...points.map((p) => p.v), 1);
  return points
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${((p.t - minX) / (maxX - minX || 1)) * w},${h - (p.v / maxV) * h}`,
    )
    .join(" ");
}

export function TpsGraph() {
  const [win, setWin] = useState(3600);
  const series = useTpsHistory(win);
  return (
    <Panel className="flex flex-col gap-2 p-3">
      <PanelHeader className="gap-3">
        <PanelTitle>Throughput (TPS)</PanelTitle>
        <div className="ml-auto flex gap-1">
          {WINDOWS.map(([label, secs]) => (
            <button
              key={secs}
              type="button"
              onClick={() => setWin(secs)}
              className={`px-2 text-xs ${win === secs ? "text-primary" : "text-muted-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </PanelHeader>
      <svg viewBox="0 0 600 120" className="h-32 w-full" preserveAspectRatio="none">
        <path
          d={path(series, 600, 120)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="text-primary"
        />
      </svg>
    </Panel>
  );
}
