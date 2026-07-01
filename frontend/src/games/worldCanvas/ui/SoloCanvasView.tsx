/**
 * Worker-hosted solo view for World Canvas — the RICH wall. Two bots self-play in the worker; this
 * folds the worker's PvpCell[] stream into the same {@link WorldCanvas} the online board uses, and
 * layers the original chrome back on: the floating toolbar, the Auto "take the wheel" toggle, and
 * the "Most painted" leaderboard. Drop-in for the old bare grid when `engineEnabled()`.
 *
 * Mirrors {@link ./PvpCanvasView PvpCanvasView.Board}: incremental fold by seq into a stable paints
 * map, bot markers + leaderboard derived from the stream ({@link ./soloCanvasAdapter}), and camera
 * jumps to a painter's latest cell. Painting seat A (Auto off) buffers cells through the session.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSoloCabinet } from "@/shell/cabinet/soloCabinet";
import { botColorHint } from "sui-tunnel-ts/protocol/worldCanvasPvp";
import { useWorldCanvasSolo } from "../useWorldCanvasSolo";
import { WorldCanvas } from "./WorldCanvas";
import { FloatingToolbar, AutoToggle, MostPainted, type ToolId } from "./FloatingToolbar";
import {
  cellKey,
  type PaintedCell,
  type CanvasFocus,
} from "../useWorldCanvasOnchain";
import {
  deriveSoloAgents,
  deriveSoloPainters,
  SEAT_ADDRESS,
} from "./soloCanvasAdapter";
import { WC, ERASER_COLOR } from "./tokens";

const CHUNK = 256;
const CANVAS_BACKGROUND = "#ffffff";
const COLLAPSE_WIDTH = 640;
/** Zoom a leaderboard/View jump eases to (HUD ~45%). Matches the PvP board. */
const PARTICIPANT_VIEW_SCALE = 4.5;

export function SoloCanvasView({
  windowId,
  onHome,
}: {
  windowId: string;
  onHome: () => void;
}) {
  const session = useWorldCanvasSolo(windowId);

  // Auto-start the solo match on mount (once).
  const startedRef = useRef(false);
  useEffect(() => {
    if (!startedRef.current && session.status === "idle") {
      startedRef.current = true;
      session.start();
    }
  }, [session.status, session]);

  if (session.status === "playing" || session.status === "settling") {
    return <Board session={session} onHome={onHome} />;
  }

  const text =
    session.status === "error"
      ? (session.error ?? "Something went wrong.")
      : session.status === "settled"
        ? "Wall closed."
        : "Starting bot battle…";
  return (
    <div className="sketch-welcome">
      <div className="sketch-welcome__card sketch-panel sketch-stroke">
        <span className="sketch-title">{text}</span>
        {session.status === "error" && (
          <button onClick={() => session.reset()} className="sketch-btn">
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

function Board({
  session,
  onHome,
}: {
  session: ReturnType<typeof useWorldCanvasSolo>;
  onHome: () => void;
}) {
  const [tool, setTool] = useState<ToolId>("draw");
  const [color, setColor] = useState(13); // Sui blue
  const [brushSize, setBrushSize] = useState(1);
  const [revision, setRevision] = useState(0);

  // Your toolbar color drives BOTH bot seats (they follow your palette while they draw), like the
  // legacy solo — the protocol's randomMove reads this hint.
  useEffect(() => {
    botColorHint.current = color;
  }, [color]);

  // Arcade cabinet: hover → pause → "Play vs Bot" overlay. Offerable while the bots auto-paint;
  // take-over hands seat A to you (Auto off). Verbs map onto the worker session.
  useSoloCabinet({
    offerable: session.auto,
    pause: session.pause,
    resume: session.resume,
    goManual: () => session.setAuto(false),
    goHome: onHome,
  });

  // Responsiveness keys off the CONTAINER width (freely-resizable window), not the viewport.
  const rootRef = useRef<HTMLDivElement>(null);
  const [collapse, setCollapse] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      const next = width < COLLAPSE_WIDTH;
      setCollapse((prev) => (prev === next ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fold the worker's co-signed cell stream into a stable paints map (by seq) so WorldCanvas's
  // incremental sync renders it. humanAddress="" → ALL seats render from here.
  const paintsRef = useRef<Map<string, PaintedCell>>(new Map());
  const appliedRef = useRef(0);
  useEffect(() => {
    let added = false;
    for (const c of session.view ?? []) {
      if (c.seq <= appliedRef.current) continue;
      appliedRef.current = c.seq;
      const cx = Math.floor(c.gx / CHUNK);
      const cy = Math.floor(c.gy / CHUNK);
      const x = c.gx - cx * CHUNK;
      const y = c.gy - cy * CHUNK;
      paintsRef.current.set(cellKey(BigInt(cx), BigInt(cy), x, y), {
        cx: BigInt(cx),
        cy: BigInt(cy),
        x,
        y,
        color: c.color,
        by: c.by,
        seq: c.seq,
        painter: SEAT_ADDRESS[c.by],
      });
      added = true;
    }
    if (added) setRevision((v) => v + 1);
  }, [session.view]);

  const agents = useMemo(
    () => deriveSoloAgents(session.view ?? [], session.auto),
    [session.view, session.auto],
  );
  const painters = useMemo(
    () => deriveSoloPainters(session.view ?? []),
    [session.view],
  );

  // Camera jump to a painter's latest cell (leaderboard row click).
  const [focus, setFocus] = useState<(CanvasFocus & { scale?: number }) | null>(
    null,
  );
  const focusSeq = useRef(0);
  const focusOnAgent = (address: string) => {
    const seat = address === SEAT_ADDRESS.B ? "B" : "A";
    const cells = session.view ?? [];
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i].by === seat) {
        setFocus({
          gx: cells[i].gx,
          gy: cells[i].gy,
          seq: ++focusSeq.current,
          scale: PARTICIPANT_VIEW_SCALE,
        });
        return;
      }
    }
  };

  // Watch-only while Auto is on or the hand tool is picked; flip Auto off to paint seat A.
  const panOnly = tool === "hand" || session.auto;
  const effectiveColor = tool === "erase" ? ERASER_COLOR : color;

  return (
    <div ref={rootRef} style={rootStyle}>
      <WorldCanvas
        paints={paintsRef.current}
        revision={revision}
        selectedColor={effectiveColor}
        brushSize={brushSize}
        panOnly={panOnly}
        disabled={false}
        onPaint={(cx, cy, x, y, c) =>
          session.paint(Number(cx) * CHUNK + x, Number(cy) * CHUNK + y, c)
        }
        agents={agents}
        focus={focus}
        humanAddress=""
        background={CANVAS_BACKGROUND}
        erasing={tool === "erase"}
      />

      <div style={topBarStyle}>
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
      </div>
      <div style={autoCornerStyle}>
        <AutoToggle auto={session.auto} onToggleAuto={session.toggleAuto} />
      </div>

      <MostPainted
        painters={painters}
        auto={session.auto}
        onViewPainter={focusOnAgent}
      />
    </div>
  );
}

const rootStyle: CSSProperties = {
  height: "100%",
  width: "100%",
  position: "relative",
  overflow: "hidden",
  background: WC.bg,
};
const topBarStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  left: 112,
  zIndex: 60,
  display: "flex",
  width: "fit-content",
  maxWidth: "calc(100% - 126px)",
  pointerEvents: "none",
};
const autoCornerStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  zIndex: 60,
  pointerEvents: "none",
};
