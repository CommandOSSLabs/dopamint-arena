import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useWorldCanvasOnchain } from "../useWorldCanvasOnchain";
import { WorldCanvas } from "./WorldCanvas";
import {
  FloatingToolbar,
  AutoToggle,
  MostPainted,
  type ToolId,
} from "./FloatingToolbar";
import { WC, ERASER_COLOR } from "./tokens";

/** Below this width the full 9-swatch palette no longer fits one row, so it collapses to a
 *  single current-color swatch + popover (keeping the toolbar to one tidy row). */
const COLLAPSE_WIDTH = 640;

/** The fixed canvas backdrop — Excalidraw-style white. Passed straight to WorldCanvas so
 *  the eraser can render this color to "erase" (phase 2 relies on it). No picker. */
const CANVAS_BACKGROUND = "#ffffff";

/**
 * The lean canvas shell — opening the game lands you straight here, ready to draw (no
 * splash, no start menu, no mode picker). The chunked wall sits behind one
 * Excalidraw-style floating toolbar (tools + a few colors + brush size), the
 * {@link ArenaControl} Auto "take the wheel" toggle, and the {@link MostPainted} readout.
 * Every painted cell is one co-signed off-chain move on the ONE strictly-2-party tunnel;
 * free/draw, so the only score is who painted the most.
 */
export function CanvasView() {
  const engine = useWorldCanvasOnchain();
  const [tool, setTool] = useState<ToolId>("draw");
  const [color, setColor] = useState(13); // Sui blue
  const [brushSize, setBrushSize] = useState(1);

  // The canvas lives inside a freely-resizable window, so responsiveness keys off the
  // CONTAINER (not the viewport): a ResizeObserver flips the layout flags only when the
  // width crosses a breakpoint, so it never re-renders per resize pixel.
  const rootRef = useRef<HTMLDivElement>(null);
  const [collapse, setCollapse] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      const nextCollapse = width < COLLAPSE_WIDTH;
      setCollapse((prev) => (prev === nextCollapse ? prev : nextCollapse));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const tps = useRollingTps(engine.status.movesCoSigned);

  // The hand tool pans; the eraser renders the backdrop; everything else paints `color`.
  // The wall is pan-only (watch) while Auto is on or while the hand tool is picked — flip
  // Auto off to take the wheel and paint seat A.
  const panOnly = tool === "hand" || engine.auto;
  const effectiveColor = tool === "erase" ? ERASER_COLOR : color;

  const toolbar = (
    <FloatingToolbar
      tool={tool}
      onTool={setTool}
      color={color}
      onColor={setColor}
      brushSize={brushSize}
      onBrushSize={setBrushSize}
      stacked
      collapse={collapse}
    />
  );
  return (
    <div
      ref={rootRef}
      style={{
        height: "100%",
        width: "100%",
        position: "relative",
        overflow: "hidden",
        background: WC.bg,
      }}
    >
      <WorldCanvas
        paints={engine.paints}
        revision={engine.revision}
        generation={engine.game}
        selectedColor={effectiveColor}
        brushSize={brushSize}
        panOnly={panOnly}
        disabled={engine.status.phase === "opening"}
        onPaint={engine.submitHumanPaint}
        agents={engine.agents}
        focus={engine.focus}
        humanAddress={engine.humanAddress}
        background={CANVAS_BACKGROUND}
        erasing={tool === "erase"}
      />

      {/* Compact top bar — ONE row: the toolbar at the left, the Auto toggle at the right.
          The live TPS · View readout lives in the Most-painted card (bottom-right) so the
          bar stays a thin strip and the canvas is clear. Click-through; panels catch events. */}
      <div style={topBarStyle}>
        <div style={topRowStyle}>
          {toolbar}
          <AutoToggle auto={engine.auto} onToggleAuto={engine.toggleAuto} />
        </div>
      </div>

      <MostPainted
        painters={engine.painters}
        tps={tps}
        onViewNext={engine.viewNextAgent}
      />
    </div>
  );
}

/** The single consolidated top bar — a click-through column anchored top-center (clear of
 *  the window-owned "← Menu" at top-left). Row 1 (toolbar + Auto) and row 2 (live readout)
 *  each catch their own pointer events; the bar + the gaps between rows stay click-through
 *  so painting/panning under the bar still works. */
const topBarStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  // Anchored to the RIGHT of the window-owned "← Menu" button (top-left) so the bar never
  // overlaps it; spans to the right edge so the toolbar lays out on one row (no shrink-wrap
  // pile) with the Auto pill pushed to the far right.
  left: 112,
  right: 14,
  zIndex: 60,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 8,
  pointerEvents: "none",
};

/** The single bar row — toolbar at the left, Auto toggle pushed to the right; wraps only
 *  when truly out of room. Click-through; the toolbar island + the Auto button each catch
 *  their own pointer events (the Auto button sets pointer-events:auto so it's always clickable). */
const topRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 8,
  width: "100%",
  pointerEvents: "none",
};

/** Derive a live throughput number from the monotonic co-signed paint count via a
 *  short sliding window (sampled every 500 ms over ~3 s) — a coarse TPS dial. */
function useRollingTps(movesCoSigned: number): number {
  const [tps, setTps] = useState(0);
  const samples = useRef<{ t: number; n: number }[]>([]);
  const latest = useRef(movesCoSigned);
  latest.current = movesCoSigned;

  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      const s = samples.current;
      s.push({ t: now, n: latest.current });
      while (s.length > 1 && now - s[0].t > 3000) s.shift();
      const first = s[0];
      const dt = (now - first.t) / 1000;
      setTps(dt > 0 ? Math.max(0, (latest.current - first.n) / dt) : 0);
    }, 500);
    return () => clearInterval(id);
  }, []);

  return tps;
}
