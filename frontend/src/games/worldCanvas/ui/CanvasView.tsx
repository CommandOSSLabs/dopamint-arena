import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useSoloCabinet } from "@/shell/cabinet/soloCabinet";
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
export function CanvasView({
  onHome,
  movesPerGame,
}: {
  onHome: () => void;
  movesPerGame: number;
}) {
  const [tool, setTool] = useState<ToolId>("draw");
  const [color, setColor] = useState(13); // Sui blue
  const [brushSize, setBrushSize] = useState(1);
  // Feed the toolbar's color to the engine so the BOTS paint in your selected color too
  // (you set the palette; they follow while they draw). `movesPerGame` is the lobby-chosen
  // per-game settle cap (the canvas wipes + the tunnel settles at this many paints).
  const engine = useWorldCanvasOnchain({ botColor: color, movesPerGame });

  // Shared arcade-cabinet seam (Desktop wraps every window in <GameCabinet>). The shell owns
  // hover → pause → "Play vs Bot" overlay; here we map the verbs onto the canvas engine.
  // Offerable only while the bots auto-paint (engine.auto); take-over hands seat A to the human
  // (Auto off → you paint vs the seat-B bot on the same tunnel). Verbs are stable (engine
  // callbacks + onHome are useCallback'd), so the controller rebuilds only when `auto` flips.
  const goManual = useCallback(() => engine.setAuto(false), [engine.setAuto]);
  useSoloCabinet({
    offerable: engine.auto,
    pause: engine.pauseAgents,
    resume: engine.resumeAgents,
    goManual,
    goHome: onHome,
  });

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

      {/* Toolbar top-left (right of the window-owned "← Menu"); the Auto toggle is a small
          pill pinned to the top-RIGHT corner — same height as the toolbar, not a wide box.
          The Most-painted leaderboard sits bottom-right; TPS shows in the window chrome. */}
      <div style={topBarStyle}>{toolbar}</div>
      <div style={autoCornerStyle}>
        <AutoToggle auto={engine.auto} onToggleAuto={engine.toggleAuto} />
      </div>

      <MostPainted
        painters={engine.painters}
        auto={engine.auto}
        onViewPainter={engine.focusOnAgent}
      />
    </div>
  );
}

/** The top-left control cluster — a click-through column anchored right of the window-owned
 *  "← Menu" (top-left). The toolbar is its only child now (the Auto toggle moved to the
 *  top-right corner), so it just sizes to the toolbar. Click-through; the island sets its own
 *  pointer-events so painting/panning under it still works. */
const topBarStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  left: 112,
  zIndex: 60,
  display: "flex",
  width: "fit-content",
  maxWidth: "calc(100% - 126px)", // never overflow the window (126 = 112 left + 14 right gutter)
  pointerEvents: "none",
};

/** The Auto toggle, pinned to the top-RIGHT corner as a small pill (same height as the
 *  toolbar) — not stretched under it. Click-through wrapper; the button catches its own events. */
const autoCornerStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  zIndex: 60,
  pointerEvents: "none",
};
