import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { usePvpWorldCanvas } from "../usePvpWorldCanvas";
import { botColorHint } from "../pvpProtocol";
import { WorldCanvas } from "./WorldCanvas";
import { FloatingToolbar, type ToolId } from "./FloatingToolbar";
import {
  cellKey,
  type PaintedCell,
  type AgentMarker,
  type CanvasFocus,
} from "../useWorldCanvasOnchain";
import { GRACE_MS } from "../pvpProtocol";
import { WC, ERASER_COLOR, PALETTE } from "./tokens";

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
    // The session is module-level and survives remounts/cold-load resume, so it may already hold a
    // live (or resumed) match — its status would be off "idle". Only auto-join the queue from a
    // genuinely fresh "idle" session, so a second MpClient never clobbers the live/resumed one.
    if (m.status !== "idle") return;
    startedRef.current = true;
    m.findMatch();
  }, [m]);

  if (m.status !== "playing" && m.status !== "settling")
    return <Status m={m} />;
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
    <div className="sketch-welcome">
      <div className="sketch-welcome__card sketch-panel sketch-stroke">
        {busy && <div style={spinnerStyle} />}
        <div className="sketch-title">{text}</div>
        <p className="sketch-note">
          Online PvP — co-draw one shared canvas with another human over a
          genuine 2-party tunnel. Open this game in a second browser and pick
          “Paint vs Player” to match.
        </p>
        {m.status === "error" && (
          <button
            type="button"
            className="sketch-btn sketch-btn--go"
            onClick={m.findMatch}
          >
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

  // Your toolbar color drives YOUR seat's bot too (like solo): the autopilot's randomMove
  // reads this hint, so toggling Auto on paints in your chosen color. (Brush size already
  // flows through to bot stroke width via WorldCanvas.)
  useEffect(() => {
    botColorHint.current = color;
  }, [color]);

  // Reconnect overlay countdown: when the opponent drops mid-match, count the shared GRACE_MS down
  // to zero so the player sees exactly how long until the canvas auto-closes as a draw. The same
  // GRACE_MS drives the engine's settle deadline, so the on-screen number can't drift from it.
  // Started when peerDropped flips true; cleared the instant the opponent returns.
  const [graceLeft, setGraceLeft] = useState(0);
  useEffect(() => {
    if (!m.peerDropped) {
      setGraceLeft(0);
      return;
    }
    const deadline = Date.now() + GRACE_MS;
    const tick = () =>
      setGraceLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [m.peerDropped]);

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

  // The opponent's CURRENT color — their latest cell's palette color — so their chip + marker
  // show what THEY are painting (not a fixed seat tint), mirroring "You" = your color.
  const opponentColor = useMemo(() => {
    const cells = m.view ?? [];
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i].by === opponentSeat) {
        return PALETTE[cells[i].color] ?? SEAT_TINT[opponentSeat];
      }
    }
    return SEAT_TINT[opponentSeat];
  }, [m.view, opponentSeat]);

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
            tint: PALETTE[c.color] ?? SEAT_TINT[opponentSeat],
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
      <div className="sketch-stroke sketch-panel" style={controlBarStyle}>
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
          tint={PALETTE[color]}
          label="You"
          title="Jump to where you're painting"
          onClick={() => viewParticipant("you")}
        />
        <span style={{ opacity: 0.45, fontSize: 11 }}>vs</span>
        <ParticipantChip
          tint={opponentColor}
          label="Opp"
          title="Jump to where your opponent is painting"
          onClick={() => viewParticipant("opp")}
        />
      </div>

      {/* Reconnect overlay: the opponent dropped mid-match. Blur the canvas behind a sketch card
          with a live grace countdown. No "claim winnings" — World Canvas is free/draw, so a
          no-show just closes the canvas as a refund. Hidden the instant the opponent returns. */}
      {m.peerDropped && (
        <div style={peerDropOverlayStyle}>
          <div className="sketch-panel sketch-stroke" style={peerDropCardStyle}>
            <div style={spinnerStyle} />
            <div className="sketch-title">Opponent reconnecting…</div>
            <p className="sketch-note">Closing the canvas in {graceLeft}s</p>
          </div>
        </div>
      )}
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
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="sketch-btn sketch-btn--ghost"
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
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

/** The pre-game spinner — a thin ring spun in the brand violet (literal accent ok here). */
const spinnerStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: "50%",
  border: `3px solid ${WC.hairline}`,
  borderTopColor: WC.accent,
  animation: "spin 0.9s linear infinite",
};
const boardWrapStyle: CSSProperties = {
  height: "100%",
  width: "100%",
  position: "relative",
  overflow: "hidden",
  background: WC.bg,
};
/** Full-cover reconnect scrim — blurs the live canvas and sits above the control bar (zIndex 60). */
const peerDropOverlayStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 80,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
  background: "color-mix(in srgb, var(--background) 55%, transparent)",
};
const peerDropCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 12,
  textAlign: "center",
  maxWidth: 340,
  padding: "24px 28px",
};
const controlBarStyle: CSSProperties = {
  position: "absolute",
  bottom: 14,
  right: 14,
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 36,
  padding: "0 12px",
  fontSize: 12,
  fontWeight: 700,
  color: WC.text,
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
