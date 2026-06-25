import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useWorldCanvasOnchain } from "../useWorldCanvasOnchain";
import { WorldCanvas } from "./WorldCanvas";
import {
  FloatingToolbar,
  ArenaControl,
  AutoToggle,
  LiveReadout,
  MostPainted,
  type ToolId,
} from "./FloatingToolbar";
import { WC, ERASER_COLOR } from "./tokens";

/** Below this container width the centered toolbar and the top-right arena cluster can't
 *  float side-by-side without overlapping, so they reflow into a stacked top bar instead:
 *  the Auto pill stays top-right, the toolbar + live readout each get their own row. */
const STACK_WIDTH = 1120;

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
  const [stacked, setStacked] = useState(false);
  const [collapse, setCollapse] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      const nextStacked = width < STACK_WIDTH;
      const nextCollapse = width < COLLAPSE_WIDTH;
      setStacked((prev) => (prev === nextStacked ? prev : nextStacked));
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
      stacked={stacked}
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

      {/* Stacked (narrower than the wide floating layout fits): the Auto toggle stays a
          compact pill top-right (clearing the back button top-left), while the toolbar and
          the live readout each take their OWN row below — nothing overlaps. Wide: the
          toolbar floats top-center and the arena cluster floats top-right. */}
      {stacked ? (
        <>
          <div style={autoTogglePinStyle}>
            <AutoToggle auto={engine.auto} onToggleAuto={engine.toggleAuto} />
          </div>
          <div style={compactTopBarStyle}>
            {toolbar}
            <div style={compactReadoutSlotStyle}>
              <LiveReadout
                auto={engine.auto}
                tps={tps}
                onViewNext={engine.viewNextAgent}
                centered
              />
            </div>
          </div>
        </>
      ) : (
        <>
          {toolbar}
          <ArenaControl
            auto={engine.auto}
            tps={tps}
            onToggleAuto={engine.toggleAuto}
            onViewNext={engine.viewNextAgent}
          />
        </>
      )}

      <MostPainted painters={engine.painters} />
    </div>
  );
}

/** Narrow-width Auto pill anchor: top-right, on the same row as the (window-owned) back
 *  button at top-left — opposite corners, so they never collide. */
const autoTogglePinStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  zIndex: 61,
  pointerEvents: "auto",
};

/** The narrow-width top bar: a click-through column anchored below the back-button / Auto
 *  row that stacks the toolbar over the live readout, centered, so each owns its own row
 *  and stays fully on-screen. Its panels re-enable pointer events; gaps pass to the wall. */
const compactTopBarStyle: CSSProperties = {
  position: "absolute",
  top: 60,
  left: 8,
  right: 8,
  zIndex: 60,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
  pointerEvents: "none",
};

/** Re-enable pointer events on the readout row inside the click-through top bar. */
const compactReadoutSlotStyle: CSSProperties = {
  maxWidth: "100%",
  pointerEvents: "auto",
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
