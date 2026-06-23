import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { PALETTE, WC, FONT_DISPLAY, FONT_MONO, shortAddress } from "./tokens";
import type { PainterInfo } from "../useWorldCanvasOnchain";

/** The three lean tools: freehand draw, eraser (paints white), and pan/hand. */
export type ToolId = "draw" | "erase" | "hand";

/** Curated swatch row — a small slice of the 16-index PALETTE (each value IS the
 *  protocol color index), kept short on purpose: a few colors, no custom picker. */
const SWATCHES: readonly number[] = [3, 0, 5, 6, 8, 10, 11, 13, 14, 15];

/** Brush footprint edges offered (cells per side): a single, medium, fat nib. */
const SIZES: readonly number[] = [1, 2, 3];

/**
 * The Excalidraw-style floating toolbar: one clean, rounded, light island centered
 * at the top. Tools on the left, a few preset color swatches, and a brush-size
 * stepper — that's the whole config surface. No menus, no panels. The arena lanes
 * are their own cluster in the top-right ({@link ArenaControl}).
 */
export function FloatingToolbar({
  tool,
  onTool,
  color,
  onColor,
  brushSize,
  onBrushSize,
}: {
  tool: ToolId;
  onTool: (t: ToolId) => void;
  /** Active palette index for the draw tool. */
  color: number;
  onColor: (index: number) => void;
  brushSize: number;
  onBrushSize: (n: number) => void;
}) {
  return (
    <div style={islandStyle}>
      <ToolButton
        label="Draw"
        active={tool === "draw"}
        onClick={() => onTool("draw")}
      >
        <PencilIcon />
      </ToolButton>
      <ToolButton
        label="Eraser"
        active={tool === "erase"}
        onClick={() => onTool("erase")}
      >
        <EraserIcon />
      </ToolButton>
      <ToolButton
        label="Pan"
        active={tool === "hand"}
        onClick={() => onTool("hand")}
      >
        <HandIcon />
      </ToolButton>

      <Divider />

      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        {SWATCHES.map((idx) => {
          const on = color === idx && tool !== "erase";
          return (
            <button
              key={idx}
              type="button"
              title={`Color ${idx}`}
              aria-label={`Color ${idx}`}
              aria-pressed={on}
              onClick={() => {
                onColor(idx);
                onTool("draw"); // picking a color implies drawing
              }}
              style={{
                width: 20,
                height: 20,
                borderRadius: 5,
                cursor: "pointer",
                padding: 0,
                background: PALETTE[idx],
                border: "1px solid rgba(0,0,0,0.18)",
                boxShadow: on ? `0 0 0 2px ${WC.accent}` : "none",
              }}
            />
          );
        })}
      </div>

      <Divider />

      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        {SIZES.map((n) => {
          const on = brushSize === n;
          return (
            <button
              key={n}
              type="button"
              title={`Brush ${n}×${n}`}
              aria-label={`Brush size ${n}`}
              aria-pressed={on}
              onClick={() => onBrushSize(n)}
              style={{
                width: 28,
                height: 28,
                borderRadius: 7,
                display: "grid",
                placeItems: "center",
                cursor: "pointer",
                border: "none",
                background: on ? "#e8efff" : "transparent",
              }}
            >
              <span
                style={{
                  display: "block",
                  width: 4 + n * 3,
                  height: 4 + n * 3,
                  borderRadius: "50%",
                  background: on ? WC.accent : "#5b5b66",
                }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The arena control — two Battleship-style lanes, transposed to the shared wall.
 * Both run on REAL strictly-2-party tunnels (two DISTINCT DOPAMINT-funded seats);
 * the protocol stays free/draw, so there is never a winner or a stake shift — the
 * only score is who co-signed the most cells (the {@link MostPainted} readout).
 *
 * - **Paint with a bot** — your wall: seat A is you ({@link onPaint via the canvas}),
 *   seat B is the always-present "Wall Bot", a DISTINCT funded party co-painting the
 *   SAME tunnel. This is the resting lane; selecting it while the arena is live tears
 *   the arena down ({@link onStop}) so the camera returns to your wall.
 * - **Watch bot arena** — {@link onSpawn} opens a fresh shared tunnel authored by TWO
 *   distinct funded bots (seat A + seat B, both co-signing every paint). "+ pair"
 *   spawns another, "View" cycles the camera, "Stop" tears every spawned tunnel down
 *   (your wall + its Wall Bot keep painting).
 */
export function ArenaControl({
  agentCount,
  tps,
  onSpawn,
  onStop,
  onViewNext,
}: {
  /** SPAWNED bots currently painting (each pair adds 2). 0 ⇒ only you + the Wall Bot. */
  agentCount: number;
  /** Live co-signed throughput across every tunnel (the TPS dial). */
  tps: number;
  /** Open a fresh shared tunnel painted by a distinct funded bot pair (engine.spawnAgent). */
  onSpawn: () => void;
  /** Tear down every spawned tunnel; the human wall + Wall Bot keep painting (engine.stopAgents). */
  onStop: () => void;
  /** Cycle the camera to the next live bot (engine.viewNextAgent). */
  onViewNext: () => void;
}) {
  const arena = agentCount > 0;
  return (
    <div style={autoWrapStyle}>
      <div style={laneRowStyle}>
        <LaneTab
          label="Paint with a bot"
          icon={<BrushIcon />}
          active={!arena}
          onClick={() => {
            if (arena) onStop(); // leave the arena → back to just your wall
          }}
        />
        <LaneTab
          label="Watch bot arena"
          icon={<BotIcon />}
          active={arena}
          onClick={() => {
            if (!arena) onSpawn(); // open the first bot-vs-bot pair
          }}
        />
      </div>

      {arena ? (
        <div style={readoutStyle}>
          <LiveDot />
          <span>
            {agentCount} {agentCount === 1 ? "bot" : "bots"}
          </span>
          <span style={{ color: "#9aa3bb" }}>·</span>
          <span style={{ color: WC.text }}>{Math.round(tps)} TPS</span>
          <span style={readoutDividerStyle} />
          <button
            type="button"
            onClick={onSpawn}
            title="Spawn another funded bot pair"
            style={pillButtonStyle}
          >
            + pair
          </button>
          <button
            type="button"
            onClick={onViewNext}
            title="Jump the camera to the next bot"
            style={pillButtonStyle}
          >
            View
          </button>
          <button type="button" onClick={onStop} style={stopPillStyle}>
            Stop
          </button>
        </div>
      ) : (
        <div style={readoutStyle}>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <SeatDot tint={WC.seatA} /> You
            <span style={{ color: "#9aa3bb", margin: "0 1px" }}>+</span>
            <SeatDot tint={WC.seatB} /> Wall Bot
          </span>
          <span style={{ color: "#9aa3bb" }}>·</span>
          <span style={{ color: WC.text }}>{Math.round(tps)} TPS</span>
        </div>
      )}
    </div>
  );
}

/**
 * The "most painted" readout — a small, lightweight leaderboard of the top painters
 * by co-signed cell count. Display only: NO money, NO winner (the protocol is
 * free/draw). Reads the live {@link PainterInfo} tally from the engine on a coarse
 * interval, so the panel never re-renders at the paint rate. Hidden until the first
 * cell lands.
 */
export function MostPainted({
  painters,
}: {
  /** Per-painter tallies, keyed by address (stable identity, mutated in place). */
  painters: ReadonlyMap<string, PainterInfo>;
}) {
  const top = useTopPainters(painters, 5);
  if (top.length === 0) return null;
  return (
    <div style={mostPaintedStyle}>
      <div style={mostPaintedHeaderStyle}>
        <BrushIcon size={12} />
        Most painted
      </div>
      {top.map((p) => (
        <div key={p.address} style={leaderRowStyle}>
          <SeatDot tint={p.tint} />
          <span style={leaderLabelStyle}>{p.label}</span>
          <span style={leaderAddrStyle}>{shortAddress(p.address)}</span>
          <span style={leaderCountStyle}>{formatCount(p.cells)}</span>
        </div>
      ))}
    </div>
  );
}

/** Snapshot the top-N painters by cell count, sampled on a coarse interval (not at the
 *  paint rate) — the live Map has stable identity and is mutated in place, so polling
 *  it is enough; ties break toward the painter who acted earliest (steadier ordering). */
function useTopPainters(
  painters: ReadonlyMap<string, PainterInfo>,
  limit: number,
): PainterInfo[] {
  const [top, setTop] = useState<PainterInfo[]>([]);
  const latest = useRef(painters);
  latest.current = painters;
  useEffect(() => {
    const sample = () => {
      const ranked = [...latest.current.values()]
        .filter((p) => p.cells > 0)
        .sort((a, b) => b.cells - a.cells || a.lastSeq - b.lastSeq)
        .slice(0, limit);
      setTop(ranked);
    };
    sample();
    const id = setInterval(sample, 600);
    return () => clearInterval(id);
  }, [limit]);
  return top;
}

/** Compact large tallies (paint-forever counts get big): 1.2k / 34k / 1.1M. */
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

/** One lane of the arena control: a segmented tab, active = accent fill. */
function LaneTab({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        height: 32,
        padding: "0 12px",
        borderRadius: 9,
        border: "none",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 12.5,
        fontWeight: 700,
        whiteSpace: "nowrap",
        color: active ? "#06203B" : WC.text,
        background: active
          ? WC.accent
          : hover
            ? "rgba(255,255,255,0.08)"
            : "transparent",
        transition: "background .12s, color .12s",
      }}
    >
      <span
        style={{
          display: "grid",
          placeItems: "center",
          color: active ? "#06203B" : WC.muted,
        }}
      >
        {icon}
      </span>
      {label}
    </button>
  );
}

/** A small square seat/painter swatch (echoes a painted pixel). */
function SeatDot({ tint }: { tint: string }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 2,
        background: tint,
        flex: "0 0 auto",
      }}
    />
  );
}

/** The pulsing "live" accent dot shown beside the active arena's TPS. */
function LiveDot() {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: WC.accent,
        boxShadow: `0 0 8px ${WC.accent}`,
        flex: "0 0 auto",
      }}
    />
  );
}

/** A toolbar tool button with a subtle Excalidraw-style hover + active state. */
function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 34,
        height: 34,
        borderRadius: 8,
        display: "grid",
        placeItems: "center",
        cursor: "pointer",
        border: "none",
        color: active ? WC.accent : "#1b1b1f",
        background: active ? "#e8efff" : hover ? "#f1f1f4" : "transparent",
        transition: "background .1s",
      }}
    >
      {children}
    </button>
  );
}

function Divider() {
  return (
    <span style={{ width: 1, height: 22, background: "#e6e6ea", flex: "0 0 auto" }} />
  );
}

const islandStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: 6,
  borderRadius: 12,
  background: "#ffffff",
  border: "1px solid #e9e9ed",
  boxShadow: "0 2px 14px rgba(0,0,0,0.18)",
  fontFamily: FONT_DISPLAY,
};

/** Top-right arena cluster: the two-lane selector stacked above its context strip. */
const autoWrapStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  zIndex: 60,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 8,
  fontFamily: FONT_DISPLAY,
};

/** The segmented two-lane container (dark glass, holds the {@link LaneTab}s). */
const laneRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: 4,
  borderRadius: 12,
  background: "rgba(10,16,34,0.72)",
  border: "1px solid rgba(255,255,255,0.12)",
  backdropFilter: "blur(8px)",
};

const readoutStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  height: 36,
  padding: "0 12px",
  borderRadius: 10,
  fontSize: 12.5,
  fontWeight: 700,
  color: WC.text,
  fontFamily: FONT_MONO,
  background: "rgba(10,16,34,0.72)",
  border: "1px solid rgba(255,255,255,0.12)",
  backdropFilter: "blur(8px)",
};

const readoutDividerStyle: CSSProperties = {
  width: 1,
  height: 16,
  background: "rgba(255,255,255,0.14)",
  margin: "0 2px",
  flex: "0 0 auto",
};

const pillButtonStyle: CSSProperties = {
  height: 26,
  padding: "0 10px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.14)",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 700,
  color: WC.text,
  background: "rgba(255,255,255,0.06)",
};

const stopPillStyle: CSSProperties = {
  height: 26,
  padding: "0 12px",
  borderRadius: 8,
  border: "none",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 700,
  color: "#fff",
  background: "#e0556a",
};

/** Bottom-right "most painted" leaderboard card (dark glass, lightweight). */
const mostPaintedStyle: CSSProperties = {
  position: "absolute",
  right: 14,
  bottom: 18,
  zIndex: 60,
  minWidth: 176,
  maxWidth: 224,
  display: "flex",
  flexDirection: "column",
  gap: 3,
  padding: "9px 11px",
  borderRadius: 12,
  background: "rgba(10,16,34,0.72)",
  border: "1px solid rgba(255,255,255,0.12)",
  backdropFilter: "blur(8px)",
  fontFamily: FONT_DISPLAY,
};

const mostPaintedHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginBottom: 3,
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: ".14em",
  textTransform: "uppercase",
  color: WC.muted,
};

const leaderRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  height: 19,
};

const leaderLabelStyle: CSSProperties = {
  flex: "0 0 auto",
  fontSize: 12,
  fontWeight: 700,
  color: WC.text,
};

const leaderAddrStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 10,
  color: WC.muted,
  fontFamily: FONT_MONO,
};

const leaderCountStyle: CSSProperties = {
  flex: "0 0 auto",
  marginLeft: "auto",
  fontSize: 12,
  fontWeight: 800,
  color: WC.text,
  fontFamily: FONT_MONO,
  fontVariantNumeric: "tabular-nums",
};

/* --- inline icons (lucide-style, stroke = currentColor; size defaults to 18px) --- */

function iconProps(size = 18) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
}

function PencilIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function EraserIcon() {
  return (
    <svg {...iconProps()}>
      <path d="m7 21-4.3-4.3a2 2 0 0 1 0-2.8l9.6-9.6a2 2 0 0 1 2.8 0l5.6 5.6a2 2 0 0 1 0 2.8L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </svg>
  );
}

function HandIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M18 11V6a2 2 0 0 0-4 0" />
      <path d="M14 10V4a2 2 0 0 0-4 0v2" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  );
}

function BotIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...iconProps(size)}>
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <path d="M12 7v4" />
      <circle cx="12" cy="5" r="2" />
      <path d="M8 16h.01M16 16h.01" />
    </svg>
  );
}

function BrushIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...iconProps(size)}>
      <path d="m14.622 17.897-10.68-2.913" />
      <path d="M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 8.354a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z" />
      <path d="M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15" />
    </svg>
  );
}
