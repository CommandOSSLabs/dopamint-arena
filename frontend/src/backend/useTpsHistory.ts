import { useEffect, useRef, useState } from "react";
import {
  getControlPlaneClient,
  type StatsHistoryQuery,
  type StatsSnapshot,
} from "./controlPlane";

export type TpsPoint = { t: number; v: number };

export function capSeries(points: TpsPoint[], maxLen: number): TpsPoint[] {
  return points.length <= maxLen
    ? points
    : points.slice(points.length - maxLen);
}

/**
 * Decimate to at most `target` points, keeping the PEAK of each time-bucket. A 6h window holds
 * ~21.6k 1-second samples but the chart is only ~600px wide — drawing them all is wasted work.
 * Keeping the max per bucket (not every-Nth) means throughput spikes, the headline of this view,
 * survive the downsample instead of being sliced away.
 */
export function downsample(points: TpsPoint[], target: number): TpsPoint[] {
  if (points.length <= target) return points;
  const bucket = Math.ceil(points.length / target);
  const out: TpsPoint[] = [];
  for (let i = 0; i < points.length; i += bucket) {
    let peak = points[i];
    for (let j = i + 1; j < i + bucket && j < points.length; j++) {
      if (points[j].v > peak.v) peak = points[j];
    }
    out.push(peak);
  }
  return out;
}

/**
 * TPS series for the chart, in one of two modes:
 *  - a trailing `{ window }` (seconds): seed the last `window`, then append each new live SSE
 *    sample — the default, live-updating mode.
 *  - an absolute `{ from, to }` range: a static historical view, fetched once with no live tail
 *    (the range ended in the past, so "now" doesn't belong on it).
 *
 * The live `snapshot` is passed in (not fetched here) so the page runs ONE `/v1/stats/live`
 * stream shared with the metrics strip — the chart's "current" and the strip's never disagree.
 * `seedError` is true when the history fetch fails — the chart then says so instead of looking
 * like the selector did nothing.
 */
export function useTpsHistory(
  query: StatsHistoryQuery,
  snapshot: StatsSnapshot | null,
): {
  series: TpsPoint[];
  seedError: boolean;
} {
  const isWindow = "window" in query;
  // Effects key off this string so an inline-constructed `query` object doesn't re-fire them
  // every render — only a real change to the window or range does.
  const key = isWindow ? `w:${query.window}` : `r:${query.from}:${query.to}`;
  const [series, setSeries] = useState<TpsPoint[]>([]);
  const [seedError, setSeedError] = useState(false);
  const lastT = useRef(0);
  useEffect(() => {
    let alive = true;
    setSeedError(false);
    getControlPlaneClient()
      .fetchStatsHistory(query)
      .then((seed) => {
        if (alive) setSeries(seed);
      })
      .catch(() => {
        if (alive) setSeedError(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    // A fixed historical range never grows; only a trailing window tails the live feed.
    if (!isWindow || !snapshot) return;
    const t = Math.floor(Date.now() / 1000);
    if (t === lastT.current) return;
    lastT.current = t;
    const window = (query as { window: number }).window;
    setSeries((prev) => capSeries([...prev, { t, v: snapshot.tps }], window));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, key]);
  return { series, seedError };
}
