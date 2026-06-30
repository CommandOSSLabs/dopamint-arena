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

  const tps = useRollingTps(engine.status.movesCoSigned);

  // The hand tool pans; the eraser renders the backdrop; everything else paints `color`.
  // The wall is pan-only (watch) while Auto is on or while the hand tool is picked — flip
  // Auto off to take the wheel and paint seat A.
  const panOnly = tool === "hand" || engine.auto;
  const effectiveColor = tool === "erase" ? ERASER_COLOR : color;

  // Wallet gate: the wall's two seat bots open a sponsored tunnel and paint immediately, so —
  // like every other arena game — require a connected wallet before any of that runs. Until
  // then the engine holds (no tunnel, no TPS) and we show a connect prompt instead of the wall.
  if (!engine.connected) {
    return (
      <div style={connectWrapStyle}>
        <div style={connectCardStyle}>
          <div style={connectEyebrowStyle}>Wallet required</div>
          <div style={connectTitleStyle}>Connect to paint</div>
          <p style={connectNoteStyle}>
            Connect a wallet to open the shared wall — gas is sponsored, so
            watching the bots co-paint (or taking the wheel) is free.
          </p>
        </div>
      </div>
    );
  }

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
          The live TPS · View readout lives in the Most-painted card (bottom-right). */}
      <div style={topBarStyle}>{toolbar}</div>
      <div style={autoCornerStyle}>
        <AutoToggle auto={engine.auto} onToggleAuto={engine.toggleAuto} />
      </div>

      <MostPainted
        painters={engine.painters}
        tps={tps}
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

/** Wallet-gate panel — centered glass card on the canvas backdrop, shown until a wallet
 *  connects (mirrors the arena's other "connect to play" on-ramps, in CanvasView's own
 *  inline-style + WC-token idiom). */
const connectWrapStyle: CSSProperties = {
  height: "100%",
  width: "100%",
  display: "grid",
  placeItems: "center",
  padding: 24,
  background: WC.bg,
  boxSizing: "border-box",
};

const connectCardStyle: CSSProperties = {
  maxWidth: "min(22rem, 92%)",
  padding: "clamp(16px, 4cqmin, 28px)",
  textAlign: "center",
  border: `1px solid ${WC.glassBorder}`,
  background: WC.glass,
  boxShadow: WC.glow,
  backdropFilter: "blur(8px)",
  color: WC.text,
};

const connectEyebrowStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  opacity: 0.7,
};

const connectTitleStyle: CSSProperties = {
  margin: "6px 0 8px",
  fontSize: "clamp(18px, 5cqmin, 26px)",
  fontWeight: 800,
};

const connectNoteStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.5,
  opacity: 0.85,
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
