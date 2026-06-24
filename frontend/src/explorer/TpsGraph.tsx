import { useMemo, useState } from "react";
import {
  Panel,
  PanelAction,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "@/components/ui/panel";
import {
  downsample,
  useTpsHistory,
  type TpsPoint,
} from "@/backend/useTpsHistory";
import type { BackendStats } from "@/backend/useBackendStats";
import { formatCount } from "@/lib/utils";

// Trailing presets. 1D (86400s) is the backend's trailing-window ceiling; longer spans go through
// the absolute-range picker, which the server bounds to the 30-day retention.
const WINDOWS = [
  ["15m", 900],
  ["1h", 3600],
  ["6h", 21600],
  ["1D", 86400],
] as const;

const RANGE_MAX_SECS = 30 * 24 * 3600; // matches the backend's metric retention

const VIEW_W = 600;
const VIEW_H = 140;
// ~one point per horizontal pixel; the hook downsamples to this budget (peak-preserving) before
// we build the path, so a long window stays a ~600-command path, not a millions-command one.
const RENDER_BUDGET = 600;
const PAD_Y = 3; // keep the line off the exact top/bottom edge

const nowSecs = () => Math.floor(Date.now() / 1000);

// epoch-seconds ⇄ the local "YYYY-MM-DDTHH:mm" string a datetime-local input wants.
function toLocalInput(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (s: string) => Math.floor(new Date(s).getTime() / 1000);

const fmtStamp = (epochSecs: number) =>
  new Date(epochSecs * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const fmtClock = (epochSecs: number) =>
  new Date(epochSecs * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

/** A rendered point in normalized [0,1] chart coords — fed to the HTML hover overlay so the dot
 *  stays round and labels stay crisp despite the SVG's `preserveAspectRatio="none"` stretch. */
type ProjPoint = { t: number; v: number; xFrac: number; yFrac: number };

/** Line + filled-area paths, y-axis autoscaled to the window's own peak so even single-digit TPS
 *  fills the panel rather than flatlining at the bottom. */
function buildPaths(points: TpsPoint[]) {
  if (points.length < 2)
    return { line: "", area: "", peak: 0, proj: [] as ProjPoint[] };
  const xs = points.map((p) => p.t);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const peak = Math.max(...points.map((p) => p.v));
  const spanX = maxX - minX || 1;
  const spanV = peak || 1;
  const x = (t: number) => ((t - minX) / spanX) * VIEW_W;
  const y = (v: number) => VIEW_H - PAD_Y - (v / spanV) * (VIEW_H - PAD_Y * 2);
  const line = points
    .map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${VIEW_W},${VIEW_H} L0,${VIEW_H} Z`;
  const proj: ProjPoint[] = points.map((p) => ({
    t: p.t,
    v: p.v,
    xFrac: (p.t - minX) / spanX,
    yFrac: y(p.v) / VIEW_H,
  }));
  return { line, area, peak, proj };
}

// live === true → live SSE (green, pulsing); false → connecting (muted, pulsing);
// null → a static historical range (muted, no pulse).
function StatusTag({ live }: { live: boolean | null }) {
  const success = live === true;
  const label = live === null ? "Range" : success ? "Live" : "Connecting";
  return (
    <span
      className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${success ? "text-success" : "text-muted-foreground"}`}
    >
      <span
        className={`size-1.5 rounded-full ${success ? "bg-success" : "bg-muted-foreground"} ${live === null ? "" : "animate-pulse"}`}
      />
      {label}
    </span>
  );
}

export function TpsGraph({ snapshot, status }: BackendStats) {
  const [win, setWin] = useState(3600);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");

  const { series, seedError } = useTpsHistory(
    range ?? { window: win },
    snapshot,
  );
  const points = useMemo(() => downsample(series, RENDER_BUDGET), [series]);
  const { line, area, peak, proj } = useMemo(
    () => buildPaths(points),
    [points],
  );
  // Read "current" off the SAME snapshot the strip uses, so the two never show different numbers.
  const current = status === "live" ? snapshot?.tps : undefined;

  // Nearest-point hover readout. Index-by-fraction is exact enough since the rendered series is
  // (near-)uniformly spaced after downsampling; clamped so a shrinking series can't dangle a stale idx.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const hovered =
    hoverIdx != null ? proj[Math.min(hoverIdx, proj.length - 1)] : null;
  const onHoverMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (proj.length < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    setHoverIdx(
      Math.max(
        0,
        Math.min(proj.length - 1, Math.round(frac * (proj.length - 1))),
      ),
    );
  };

  // A range is a static historical view → headline its peak; a window is live → headline now.
  const heroValue = range ? peak : current;
  const heroUnit = range ? "peak tx/sec" : "tx/sec";
  const caption = seedError
    ? range
      ? "range unavailable"
      : "history unavailable · live only"
    : range
      ? `${fmtStamp(range.from)} → ${fmtStamp(range.to)}`
      : `peak ${formatCount(peak)}`;

  const fromS = fromInput ? fromLocalInput(fromInput) : NaN;
  const toS = toInput ? fromLocalInput(toInput) : NaN;
  const rangeValid =
    Number.isFinite(fromS) && Number.isFinite(toS) && fromS < toS;

  const selectPreset = (secs: number) => {
    setRange(null);
    setPickerOpen(false);
    setWin(secs);
  };
  const togglePicker = () => {
    if (!pickerOpen && !range) {
      const now = nowSecs();
      setFromInput(toLocalInput(now - 3600));
      setToInput(toLocalInput(now));
    }
    setPickerOpen((v) => !v);
  };
  const applyRange = () => {
    if (rangeValid) {
      setRange({ from: fromS, to: toS });
      setPickerOpen(false);
    }
  };

  const now = nowSecs();
  const chipClass = (active: boolean) =>
    `border-l border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors first:border-l-0 ${
      active
        ? "bg-primary text-primary-foreground"
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <Panel className="duration-500 animate-in fade-in">
      <PanelHeader>
        <PanelTitle>Throughput</PanelTitle>
        <PanelAction className="gap-2">
          <div className="flex border border-border">
            {WINDOWS.map(([label, secs]) => (
              <button
                key={secs}
                type="button"
                onClick={() => selectPreset(secs)}
                className={chipClass(!range && win === secs)}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={togglePicker}
              className={chipClass(!!range || pickerOpen)}
            >
              Custom
            </button>
          </div>
          <StatusTag live={range ? null : status === "live"} />
        </PanelAction>
      </PanelHeader>
      <PanelContent className="flex flex-col gap-2 overflow-hidden p-3">
        {pickerOpen && (
          <div className="flex flex-wrap items-end gap-2 border border-border p-2">
            <label className="flex flex-col gap-1">
              <span className="wal-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                From
              </span>
              <input
                type="datetime-local"
                value={fromInput}
                min={toLocalInput(now - RANGE_MAX_SECS)}
                max={toInput || toLocalInput(now)}
                onChange={(e) => setFromInput(e.target.value)}
                className="wal-mono border border-input bg-secondary px-2 py-1 text-[11px] text-foreground [color-scheme:light] dark:[color-scheme:dark]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="wal-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                To
              </span>
              <input
                type="datetime-local"
                value={toInput}
                min={fromInput || toLocalInput(now - RANGE_MAX_SECS)}
                max={toLocalInput(now)}
                onChange={(e) => setToInput(e.target.value)}
                className="wal-mono border border-input bg-secondary px-2 py-1 text-[11px] text-foreground [color-scheme:light] dark:[color-scheme:dark]"
              />
            </label>
            <button
              type="button"
              onClick={applyRange}
              disabled={!rangeValid}
              className="border border-primary bg-primary px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground transition-opacity disabled:opacity-40"
            >
              Apply
            </button>
            {range && (
              <button
                type="button"
                onClick={() => {
                  setRange(null);
                  setPickerOpen(false);
                }}
                className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            )}
            <span className="wal-mono ml-auto self-center text-[9px] uppercase tracking-wider text-muted-foreground">
              max 30 days
            </span>
          </div>
        )}
        <div className="flex items-baseline gap-2">
          <span className="wal-doto text-4xl tabular-nums text-primary">
            {formatCount(heroValue)}
          </span>
          <span className="wal-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {heroUnit}
          </span>
          <span className="ml-auto wal-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {caption}
          </span>
        </div>
        <div
          className="relative h-28 w-full"
          onPointerMove={onHoverMove}
          onPointerLeave={() => setHoverIdx(null)}
        >
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full text-primary"
            role="img"
            aria-label="Transactions per second over the selected window"
          >
            <defs>
              <linearGradient id="tps-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity={0.28} />
                <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((f) => (
              <line
                key={f}
                x1={0}
                x2={VIEW_W}
                y1={VIEW_H * f}
                y2={VIEW_H * f}
                className="text-border"
                stroke="currentColor"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {area && <path d={area} fill="url(#tps-area)" stroke="none" />}
            {line && (
              <path
                d={line}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {/* Hover overlay in HTML (not SVG) so the crosshair/dot/label aren't stretched by the
              non-uniform viewBox. Positioned by the point's normalized coords. */}
          {hovered && (
            <>
              <div
                className="pointer-events-none absolute bottom-0 top-0 w-px bg-primary/40"
                style={{ left: `${hovered.xFrac * 100}%` }}
              />
              <div
                className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-card"
                style={{
                  left: `${hovered.xFrac * 100}%`,
                  top: `${hovered.yFrac * 100}%`,
                }}
              />
              <div
                className="wal-mono pointer-events-none absolute top-1 -translate-x-1/2 whitespace-nowrap border border-border bg-popover px-1.5 py-0.5 text-[10px] tabular-nums text-popover-foreground"
                style={{
                  left: `${Math.min(90, Math.max(10, hovered.xFrac * 100))}%`,
                }}
              >
                {formatCount(hovered.v)}{" "}
                <span className="text-muted-foreground">
                  tx/s · {fmtClock(hovered.t)}
                </span>
              </div>
            </>
          )}
        </div>
        {proj.length >= 2 && (
          <div className="wal-mono flex justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
            <span>{fmtClock(proj[0].t)}</span>
            <span>{fmtClock(proj[Math.floor((proj.length - 1) / 2)].t)}</span>
            <span>{fmtClock(proj[proj.length - 1].t)}</span>
          </div>
        )}
      </PanelContent>
    </Panel>
  );
}
