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
 *  protocol color index), kept short on purpose: a few colors, no custom picker.
 *  Pure white (index 0) is intentionally omitted — it's the eraser/backdrop job. */
const SWATCHES: readonly number[] = [3, 5, 6, 8, 10, 11, 13, 14, 15];

/** Brush footprint edges offered (cells per side): a single, medium, fat nib. */
const SIZES: readonly number[] = [1, 2, 3];

/**
 * The Excalidraw-style floating toolbar: one rounded, faded-frost island centered at
 * the top. Tools on the left, a few preset color swatches, a brush-size stepper, and a
 * row of backdrop presets — that's the whole config surface. No menus, no panels. The
 * Auto "take the wheel" toggle is its own cluster in the top-right ({@link ArenaControl}).
 */
export function FloatingToolbar({
  tool,
  onTool,
  color,
  onColor,
  brushSize,
  onBrushSize,
  background,
  backgrounds,
  onBackground,
}: {
  tool: ToolId;
  onTool: (t: ToolId) => void;
  /** Active palette index for the draw tool. */
  color: number;
  onColor: (index: number) => void;
  brushSize: number;
  onBrushSize: (n: number) => void;
  /** Current canvas backdrop color + the presets + setter (Excalidraw-style). */
  background: string;
  backgrounds: readonly string[];
  onBackground: (hex: string) => void;
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
                background: on ? "rgba(77,162,255,0.18)" : "transparent",
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

      <Divider />

      {/* Canvas background presets (Excalidraw-style) — sets the board color. */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 5 }}
        title="Canvas background"
      >
        {backgrounds.map((hex) => {
          const on = background.toLowerCase() === hex.toLowerCase();
          return (
            <button
              key={hex}
              type="button"
              title={`Background ${hex}`}
              aria-label={`Background ${hex}`}
              aria-pressed={on}
              onClick={() => onBackground(hex)}
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                cursor: "pointer",
                padding: 0,
                background: hex,
                border: "1px solid rgba(0,0,0,0.22)",
                boxShadow: on ? `0 0 0 2px ${WC.accent}` : "none",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/** The seat-A bot's mint tint — echoes the engine's TINT_BOT_A so the readout's "Bot A"
 *  swatch matches its strokes + leaderboard row. (Bot B / human reuse the WC tokens.) */
const TINT_BOT_A = "#5fe3a1";

/**
 * The in-canvas arena cluster for the live ONE strictly-2-party tunnel: two DISTINCT
 * DOPAMINT-funded seats co-paint it (free/draw, no winner, no stake shift; the only
 * score is who co-signed the most cells — see {@link MostPainted}). The SINGLE Auto
 * toggle, "take the wheel": Auto ON = watch both bots; Auto OFF = you author seat A vs
 * the seat-B bot on the SAME tunnel. "View" cycles the camera to a live bot.
 */
export function ArenaControl({
  auto,
  tps,
  onToggleAuto,
  onViewNext,
}: {
  /** True = both seats bot-driven (watch). False = you author seat A vs the seat-B bot. */
  auto: boolean;
  /** Live co-signed throughput on the tunnel (the TPS dial). */
  tps: number;
  /** Flip Auto — swap between watch (bots vs bots) and take-the-wheel (engine.toggleAuto). */
  onToggleAuto: () => void;
  /** Cycle the camera to the next live seat bot (engine.viewNextAgent). */
  onViewNext: () => void;
}) {
  return (
    <div style={autoWrapStyle}>
      {/* The single Auto toggle — "take the wheel". ON = watch two bots co-paint one
          tunnel; OFF = you author seat A vs the seat-B bot on the SAME tunnel. */}
      <button
        type="button"
        role="switch"
        aria-checked={auto}
        onClick={onToggleAuto}
        title={
          auto
            ? "Two bots are co-painting — click to take the wheel (paint seat A)"
            : "You're painting seat A — click to hand back to the bots (watch)"
        }
        style={autoToggleStyle}
      >
        <span style={autoToggleLabelStyle}>
          <BrushIcon size={14} />
          {auto ? "Auto · watch" : "You paint"}
        </span>
        <span
          style={{
            ...switchTrackStyle,
            background: auto ? WC.accent : "rgba(255,255,255,0.18)",
          }}
        >
          <span
            style={{
              ...switchKnobStyle,
              transform: auto ? "translateX(16px)" : "translateX(0)",
            }}
          />
        </span>
      </button>

      <div style={readoutStyle}>
        <LiveDot />
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          {auto ? (
            <>
              <SeatDot tint={TINT_BOT_A} /> Bot A
              <span style={{ color: "#9aa3bb", margin: "0 1px" }}>vs</span>
              <SeatDot tint={WC.seatB} /> Bot B
            </>
          ) : (
            <>
              <SeatDot tint={WC.seatA} /> You
              <span style={{ color: "#9aa3bb", margin: "0 1px" }}>vs</span>
              <SeatDot tint={WC.seatB} /> Bot B
            </>
          )}
        </span>
        <span style={{ color: "#9aa3bb" }}>·</span>
        <span style={{ color: WC.text }}>{Math.round(tps)} TPS</span>
        <span style={readoutDividerStyle} />
        <button
          type="button"
          onClick={onViewNext}
          title="Jump the camera to the next bot"
          style={pillButtonStyle}
        >
          View
        </button>
      </div>
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
        background: active
          ? "rgba(77,162,255,0.18)"
          : hover
            ? "rgba(255,255,255,0.4)"
            : "transparent",
        transition: "background .1s",
      }}
    >
      {children}
    </button>
  );
}

function Divider() {
  return (
    <span
      style={{
        width: 1,
        height: 22,
        background: "rgba(90,100,120,0.25)",
        flex: "0 0 auto",
      }}
    />
  );
}

/** The faded-frost floating toolbar island (translucent over the dark wall). */
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
  background: WC.toolbar,
  border: `1px solid ${WC.toolbarBorder}`,
  boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  fontFamily: FONT_DISPLAY,
};

/** Top-right arena cluster: the Auto "take the wheel" toggle above its live readout. */
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

/** The single Auto toggle pill (faded glass): a label + a sliding switch — "take the
 *  wheel". ON = watch two bots co-paint; OFF = you author seat A vs the seat-B bot. */
const autoToggleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  height: 40,
  padding: "0 12px",
  borderRadius: 12,
  border: `1px solid ${WC.glassBorder}`,
  cursor: "pointer",
  background: WC.glass,
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  fontFamily: FONT_DISPLAY,
};

const autoToggleLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  fontSize: 12.5,
  fontWeight: 700,
  whiteSpace: "nowrap",
  color: WC.text,
};

/** The sliding-switch track (accent when Auto on). */
const switchTrackStyle: CSSProperties = {
  position: "relative",
  width: 34,
  height: 18,
  borderRadius: 999,
  flex: "0 0 auto",
  transition: "background .14s",
};

/** The switch knob (slides right when Auto on). */
const switchKnobStyle: CSSProperties = {
  position: "absolute",
  top: 2,
  left: 2,
  width: 14,
  height: 14,
  borderRadius: "50%",
  background: "#fff",
  boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
  transition: "transform .14s",
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
  background: WC.glass,
  border: `1px solid ${WC.glassBorder}`,
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
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
  border: `1px solid ${WC.glassBorder}`,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 700,
  color: WC.text,
  background: "rgba(255,255,255,0.06)",
};

/** Bottom-right "most painted" leaderboard card (faded glass, lightweight). */
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
  background: WC.glass,
  border: `1px solid ${WC.glassBorder}`,
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
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

function BrushIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...iconProps(size)}>
      <path d="m14.622 17.897-10.68-2.913" />
      <path d="M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 8.354a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z" />
      <path d="M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15" />
    </svg>
  );
}
