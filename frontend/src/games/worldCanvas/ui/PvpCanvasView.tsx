import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { usePvpWorldCanvas } from "../usePvpWorldCanvas";
import { WorldCanvas } from "./WorldCanvas";
import { FloatingToolbar, type ToolId } from "./FloatingToolbar";
import {
  cellKey,
  type PaintedCell,
  type AgentMarker,
  type CanvasFocus,
} from "../useWorldCanvasOnchain";
import { WC, FONT_DISPLAY, ERASER_COLOR } from "./tokens";

const CHUNK = 256;
/** Fixed canvas backdrop (matches solo) — Excalidraw-style white, passed to WorldCanvas so
 *  the eraser can render this color to "erase" (phase 2 relies on it). No picker. */
const CANVAS_BACKGROUND = "#ffffff";
const SEAT_TINT: Record<"A" | "B", string> = { A: WC.seatA, B: WC.seatB };

/** Zoom a participant-chip jump eases to (HUD ~45%): wide enough to see the painter's
 *  region with surrounding context — not nose-to-the-pixels like a fresh-spawn focus.
 *  The HUD reads scale*10%, so 4.5 ≈ 45%. */
const PARTICIPANT_VIEW_SCALE = 4.5;

/** Below this container width the full palette no longer fits one row, so the toolbar
 *  collapses its palette into a single current-color swatch + popover (matching solo) —
 *  keeping it one tidy row instead of wrapping into a grid that buries the PvP canvas. */
const COLLAPSE_WIDTH = 640;

/**
 * Online PvP: two humans matched over the relay co-draw ONE shared canvas on a GENUINE
 * 2-party tunnel (each owns a seat; the engine exchanges half-signatures peer-to-peer).
 * Auto-joins the queue on open. Once playing, it renders with the SAME {@link WorldCanvas}
 * as Paint-vs-Bot — the co-signed cell stream (both seats) folds into smooth ink, the
 * opponent's latest cell is tracked as a marker, and the Auto toggle lets a bot paint your
 * seat (mirroring the other games' PvP). Turn-based: the seats co-sign alternately.
 */
export function PvpCanvasView({ windowId }: { windowId: string }) {
  const m = usePvpWorldCanvas(windowId);
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    m.findMatch();
  }, [m]);

  if (m.status !== "playing" && m.status !== "settling") return <Status m={m} />;
  return <Board m={m} />;
}

/** Pre-game / transitional states (matching, funding, settled, error). */
function Status({ m }: { m: ReturnType<typeof usePvpWorldCanvas> }) {
  const text =
    m.status === "matching"
      ? "Finding a painter…"
      : m.status === "funding"
        ? "Opening the shared tunnel…"
        : m.status === "settled"
          ? "Match closed."
          : m.status === "error"
            ? (m.error ?? "Something went wrong.")
            : "Connecting…";
  const busy = m.status === "matching" || m.status === "funding";
  return (
    <div style={wrapStyle}>
      <div style={cardStyle}>
        {busy && <div style={spinnerStyle} />}
        <div style={titleStyle}>{text}</div>
        <div style={subStyle}>
          Online PvP — co-draw one shared canvas with another human over a genuine
          2-party tunnel. Open this game in a second browser and pick “Paint vs Player”
          to match.
        </div>
        {m.status === "error" && (
          <button type="button" style={retryStyle} onClick={m.findMatch}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

/** The live co-draw board — reuses the solo WorldCanvas, fed the PvP cell stream. */
function Board({ m }: { m: ReturnType<typeof usePvpWorldCanvas> }) {
  const [tool, setTool] = useState<ToolId>("draw");
  const [color, setColor] = useState(13);
  const [brushSize, setBrushSize] = useState(1);
  const [revision, setRevision] = useState(0);

  // Responsiveness keys off the CONTAINER width (the window is freely resizable), not the
  // viewport: a ResizeObserver flips `collapse` only when the width crosses the breakpoint,
  // so the toolbar stays one row instead of wrapping over the canvas at narrow sizes.
  const rootRef = useRef<HTMLDivElement>(null);
  const [collapse, setCollapse] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      const next = width < COLLAPSE_WIDTH;
      setCollapse((prev) => (prev === next ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fold the co-signed cell stream into a stable paints map (by seq) so WorldCanvas's
  // incremental sync renders it. humanAddress="" below → ALL seats render from here
  // (you, your auto-bot, AND the opponent).
  const paintsRef = useRef<Map<string, PaintedCell>>(new Map());
  const appliedRef = useRef(0);
  useEffect(() => {
    let added = false;
    for (const c of m.view ?? []) {
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
        painter: c.by,
      });
      added = true;
    }
    if (added) setRevision((v) => v + 1);
  }, [m.view]);

  // Camera-jump: clicking a participant chip eases the wall to THAT painter's latest cell
  // (direct navigation), carrying a comfortable target zoom so their area is actually
  // visible. The optional `scale` rides on the focus request WorldCanvas already eases to.
  const [focus, setFocus] = useState<(CanvasFocus & { scale?: number }) | null>(
    null,
  );
  const focusSeq = useRef(0);

  const opponentSeat: "A" | "B" = m.role === "A" ? "B" : "A";

  // Jump to where a given side is drawing: scan for that seat's MOST-RECENT cell, center
  // it, and ease the zoom to PARTICIPANT_VIEW_SCALE. No-op if that painter hasn't drawn yet.
  const viewParticipant = (which: "you" | "opp") => {
    const cells = m.view ?? [];
    const want = which === "you" ? m.role : opponentSeat;
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i].by === want) {
        const target = cells[i];
        setFocus({
          gx: target.gx,
          gy: target.gy,
          seq: ++focusSeq.current,
          scale: PARTICIPANT_VIEW_SCALE,
        });
        return;
      }
    }
  };

  const agents: AgentMarker[] = useMemo(() => {
    const cells = m.view ?? [];
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i].by === opponentSeat) {
        const c = cells[i];
        return [
          {
            id: "opponent",
            label: `Opponent · ${opponentSeat}`,
            painter: opponentSeat,
            flagName: "co-draw",
            tint: SEAT_TINT[opponentSeat],
            gx: c.gx,
            gy: c.gy,
            h: 6,
          },
        ];
      }
    }
    return [];
  }, [m.view, opponentSeat]);

  const panOnly = tool === "hand" || m.auto;

  return (
    <div ref={rootRef} style={boardWrapStyle}>
      <WorldCanvas
        paints={paintsRef.current}
        revision={revision}
        selectedColor={tool === "erase" ? ERASER_COLOR : color}
        brushSize={brushSize}
        panOnly={panOnly}
        disabled={false}
        onPaint={(cx, cy, x, y, c) =>
          m.paint(Number(cx) * CHUNK + x, Number(cy) * CHUNK + y, c)
        }
        agents={agents}
        focus={focus}
        humanAddress=""
        background={CANVAS_BACKGROUND}
        erasing={tool === "erase"}
      />

      <FloatingToolbar
        tool={tool}
        onTool={setTool}
        color={color}
        onColor={setColor}
        brushSize={brushSize}
        onBrushSize={setBrushSize}
        collapse={collapse}
      />

      {/* PvP control (bottom-right) — one slim bar: Auto toggle · clickable You/Opp chips
          (each jumps the camera to that painter's latest cell). */}
      <div style={controlBarStyle}>
        <button
          type="button"
          role="switch"
          aria-checked={m.auto}
          onClick={m.toggleAuto}
          title={
            m.auto
              ? "A bot is painting your seat — click to take the wheel"
              : "You're painting your seat — click to let the bot paint it"
          }
          style={ctlButtonStyle}
        >
          <span
            style={{
              ...trackStyle,
              background: m.auto ? WC.accent : WC.track,
            }}
          >
            <span
              style={{
                ...knobStyle,
                transform: m.auto ? "translateX(14px)" : "translateX(0)",
              }}
            />
          </span>
          Auto
        </button>
        <span style={ctlDividerStyle} />
        <ParticipantChip
          tint={SEAT_TINT[m.role ?? "A"]}
          label="You"
          title="Jump to where you're painting"
          onClick={() => viewParticipant("you")}
        />
        <span style={{ opacity: 0.45, fontSize: 11 }}>vs</span>
        <ParticipantChip
          tint={SEAT_TINT[opponentSeat]}
          label="Opp"
          title="Jump to where your opponent is painting"
          onClick={() => viewParticipant("opp")}
        />
      </div>
    </div>
  );
}

/** A clickable seat pill ("You" / "Opp"): the seat-tint dot + label in a pointer-cursor
 *  chip that lifts on hover, so it reads as the view action — clicking jumps the camera to
 *  that painter. (Inline styles can't do `:hover`, so a local flag drives the lift.) */
function ParticipantChip({
  tint,
  label,
  title,
  onClick,
}: {
  tint: string;
  label: string;
  title: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      style={{
        ...participantChipStyle,
        background: hover ? WC.softFillHover : WC.softFill,
        borderColor: hover ? WC.hairline : WC.glassBorder,
      }}
    >
      <SeatDot tint={tint} />
      {label}
    </button>
  );
}

function SeatDot({ tint }: { tint: string }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 0,
        background: tint,
        flex: "0 0 auto",
      }}
    />
  );
}

const wrapStyle: CSSProperties = {
  height: "100%",
  width: "100%",
  display: "grid",
  placeItems: "center",
  background:
    "radial-gradient(120% 100% at 50% -10%, color-mix(in srgb, var(--primary) 8%, var(--background)) 0%, var(--background) 60%)",
  fontFamily: FONT_DISPLAY,
};
const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 12,
  textAlign: "center",
  color: WC.text,
  maxWidth: 380,
  padding: 24,
};
const spinnerStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: "50%",
  border: `3px solid ${WC.hairline}`,
  borderTopColor: WC.accent,
  animation: "spin 0.9s linear infinite",
};
const titleStyle: CSSProperties = { fontSize: 18, fontWeight: 800, color: WC.text };
const subStyle: CSSProperties = { fontSize: 13, lineHeight: 1.55, color: WC.muted };
const retryStyle: CSSProperties = {
  marginTop: 6,
  height: 38,
  padding: "0 18px",
  borderRadius: 0,
  border: "none",
  cursor: "pointer",
  fontWeight: 800,
  color: "var(--primary-foreground)",
  background: WC.accent,
  boxShadow: WC.glow,
};
const boardWrapStyle: CSSProperties = {
  height: "100%",
  width: "100%",
  position: "relative",
  overflow: "hidden",
  background: WC.bg,
  fontFamily: FONT_DISPLAY,
};
const controlBarStyle: CSSProperties = {
  position: "absolute",
  bottom: 14,
  right: 14,
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 34,
  padding: "0 10px",
  borderRadius: 0,
  fontFamily: FONT_DISPLAY,
  fontSize: 12,
  fontWeight: 700,
  color: WC.text,
  background: WC.glass,
  border: `1px solid ${WC.glassBorder}`,
  backdropFilter: "blur(8px)",
  boxShadow: WC.glow,
};
const ctlButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 24,
  padding: 0,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 700,
  color: WC.text,
};
const participantChipStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  height: 24,
  padding: "0 9px",
  borderRadius: 0,
  border: `1px solid ${WC.glassBorder}`,
  background: WC.softFill,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 700,
  color: WC.text,
  transition: "background .12s, border-color .12s",
};
const ctlDividerStyle: CSSProperties = {
  width: 1,
  height: 16,
  background: WC.glassBorder,
  flex: "0 0 auto",
};
const trackStyle: CSSProperties = {
  position: "relative",
  width: 30,
  height: 16,
  borderRadius: 999,
  flex: "0 0 auto",
  transition: "background .14s",
};
const knobStyle: CSSProperties = {
  position: "absolute",
  top: 2,
  left: 2,
  width: 12,
  height: 12,
  borderRadius: "50%",
  background: "#fff",
  boxShadow: "0 1px 2px rgba(12,15,29,0.28)",
  transition: "transform .14s",
};
