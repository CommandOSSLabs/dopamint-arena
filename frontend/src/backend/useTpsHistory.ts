import { useEffect, useRef, useState } from "react";
import { getControlPlaneClient } from "./controlPlane";
import { useBackendStats } from "./useBackendStats";

export type TpsPoint = { t: number; v: number };

export function capSeries(points: TpsPoint[], maxLen: number): TpsPoint[] {
  return points.length <= maxLen ? points : points.slice(points.length - maxLen);
}

/** Historical seed (one fetch) + live tail from each new SSE tps sample. */
export function useTpsHistory(windowSecs: number): TpsPoint[] {
  const [series, setSeries] = useState<TpsPoint[]>([]);
  const { snapshot } = useBackendStats();
  const lastT = useRef(0);
  useEffect(() => {
    let alive = true;
    getControlPlaneClient()
      .fetchStatsHistory(windowSecs)
      .then((seed) => {
        if (alive) setSeries(seed);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [windowSecs]);
  useEffect(() => {
    if (!snapshot) return;
    const t = Math.floor(Date.now() / 1000);
    if (t === lastT.current) return;
    lastT.current = t;
    setSeries((prev) => capSeries([...prev, { t, v: snapshot.tps }], windowSecs));
  }, [snapshot, windowSecs]);
  return series;
}
