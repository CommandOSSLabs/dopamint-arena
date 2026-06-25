import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { PALETTE, WC, FONT_MONO, shortAddress } from "./tokens";
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
 * the top, laid out as a single compact row — tools on the left, a few preset color
 * swatches, then a brush-size stepper. That's the whole config surface. No menus, no
 * panels. The Auto "take the wheel" toggle is its own cluster in the top-right
 * ({@link ArenaControl}).
 */
export function FloatingToolbar({
  tool,
  onTool,
  color,
  onColor,
  brushSize,
  onBrushSize,
  stacked = false,
  collapse = false,
}: {
  tool: ToolId;
  onTool: (t: ToolId) => void;
  /** Active palette index for the draw tool. */
  color: number;
  onColor: (index: number) => void;
  brushSize: number;
  onBrushSize: (n: number) => void;
  /** Drop the absolute float for an in-flow island the parent stacks in its top bar. */
  stacked?: boolean;
  /** Collapse the inline palette into a single current-color swatch + popover (and drop
   *  the dividers) so the island stays one tidy row at narrow widths. */
  collapse?: boolean;
}) {
  return (
    <div
      className="sketch-stroke sketch-panel"
      style={stacked ? { ...islandStyle, ...islandStackedStyle } : islandStyle}
    >
      <div style={toolGroupStyle}>
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
      </div>

      {!collapse && <Divider />}

      {/* Wide: the full inline palette. Narrow: one current-color swatch that opens a
          popover of the same colors — so the island stays a single, uncramped row. */}
      {collapse ? (
        <ColorPalettePopover
          color={color}
          erasing={tool === "erase"}
          onColor={onColor}
          onTool={onTool}
        />
      ) : (
        <div style={swatchGroupStyle}>
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
                style={swatchButtonStyle(PALETTE[idx], on)}
              />
            );
          })}
        </div>
      )}

      {!collapse && <Divider />}

      {/* Wide: the three brush dots inline. Narrow: one current-size dot + popover, so the
          toolbar stays a single compact row (leaving the wall visible) — matching the palette. */}
      {collapse ? (
        <BrushSizePopover brushSize={brushSize} onBrushSize={onBrushSize} />
      ) : (
        <div style={brushGroupStyle}>
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
                className={`sketch-btn ${on ? "sketch-btn--go" : "sketch-btn--ghost"}`}
                style={{
                  width: 30,
                  height: 30,
                  padding: 0,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <span
                  style={{
                    display: "block",
                    width: 4 + n * 3,
                    height: 4 + n * 3,
                    borderRadius: "50%",
                    background: on
                      ? "var(--sketch-accent)"
                      : "var(--sketch-ink-soft)",
                  }}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Narrow-width brush control: one current-size dot that opens a popover of the three
 *  sizes — the {@link ColorPalettePopover} sibling for brush size, so the collapsed toolbar
 *  stays one row. */
function BrushSizePopover({
  brushSize,
  onBrushSize,
}: {
  brushSize: number;
  onBrushSize: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const dot = (n: number, on: boolean) => (
    <span
      style={{
        display: "block",
        width: 4 + n * 3,
        height: 4 + n * 3,
        borderRadius: "50%",
        background: on ? "var(--sketch-accent)" : "var(--sketch-ink-soft)",
      }}
    />
  );
  return (
    <div style={{ position: "relative", display: "flex" }}>
      <button
        type="button"
        title="Brush size"
        aria-label="Brush size"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="sketch-btn sketch-btn--ghost"
        style={{
          width: 30,
          height: 30,
          padding: 0,
          display: "grid",
          placeItems: "center",
        }}
      >
        {dot(brushSize, true)}
      </button>
      {open && (
        <>
          <div style={popoverBackdropStyle} onClick={() => setOpen(false)} />
          <div style={popoverStyle}>
            {SIZES.map((n) => (
              <button
                key={n}
                type="button"
                title={`Brush ${n}×${n}`}
                aria-label={`Brush size ${n}`}
                onClick={() => {
                  onBrushSize(n);
                  setOpen(false);
                }}
                className={`sketch-btn ${brushSize === n ? "sketch-btn--go" : "sketch-btn--ghost"}`}
                style={{
                  width: 30,
                  height: 30,
                  padding: 0,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                {dot(n, brushSize === n)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** A single palette swatch (rounded square). The active swatch gets an accent ring. */
function swatchButtonStyle(fill: string, on: boolean): CSSProperties {
  return {
    width: 20,
    height: 20,
    borderRadius: 0,
    cursor: "pointer",
    padding: 0,
    background: fill,
    border: `1px solid ${WC.hairline}`,
    boxShadow: on ? `0 0 0 2px ${WC.accent}` : "none",
  };
}

/**
 * Narrow-width color control: one swatch of the active color that opens a small popover
 * grid of the same {@link SWATCHES}. Keeps the compact toolbar to a single row instead of
 * wrapping the full palette. A transparent backdrop closes it on an outside click/tap.
 */
function ColorPalettePopover({
  color,
  erasing,
  onColor,
  onTool,
}: {
  color: number;
  erasing: boolean;
  onColor: (index: number) => void;
  onTool: (t: ToolId) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative", display: "flex" }}>
      <button
        type="button"
        title="Pick color"
        aria-label="Pick color"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={currentSwatchStyle(PALETTE[color], !erasing)}
      />
      {open && (
        <>
          <div style={popoverBackdropStyle} onClick={() => setOpen(false)} />
          <div className="sketch-stroke sketch-panel" style={popoverStyle}>
            {SWATCHES.map((idx) => (
              <button
                key={idx}
                type="button"
                title={`Color ${idx}`}
                aria-label={`Color ${idx}`}
                onClick={() => {
                  onColor(idx);
                  onTool("draw"); // picking a color implies drawing
                  setOpen(false);
                }}
                style={swatchButtonStyle(
                  PALETTE[idx],
                  color === idx && !erasing,
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** The seat-A bot's mint tint — echoes the engine's TINT_BOT_A so the readout's "Bot A"
 *  swatch matches its strokes + leaderboard row. Arena wal-mint. (Bot B / human reuse WC.) */
const TINT_BOT_A = "#9cefcf";

/**
 * The in-canvas arena cluster for the live ONE strictly-2-party tunnel: two DISTINCT
 * MTPS-funded seats co-paint it (free/draw, no winner, no stake shift; the only
 * score is who co-signed the most cells — see {@link MostPainted}). The SINGLE Auto
 * toggle, "take the wheel": Auto ON = watch both bots; Auto OFF = you author seat A vs
 * the seat-B bot on the SAME tunnel. "View" cycles the camera to a live bot.
 */
export function ArenaControl({
  auto,
  tps,
  onToggleAuto,
  onViewNext,
  game,
  movesThisGame,
  movesPerGame,
}: {
  /** True = both seats bot-driven (watch). False = you author seat A vs the seat-B bot. */
  auto: boolean;
  /** Live co-signed throughput on the tunnel (the TPS dial). */
  tps: number;
  /** Flip Auto — swap between watch (bots vs bots) and take-the-wheel (engine.toggleAuto). */
  onToggleAuto: () => void;
  /** Cycle the camera to the next live seat bot (engine.viewNextAgent). */
  onViewNext: () => void;
  /** Current bounded-game number (engine.game). */
  game: number;
  /** Co-signed moves this game (engine.movesThisGame). */
  movesThisGame: number;
  /** Per-game co-signed-move cap (engine.movesPerGame). */
  movesPerGame: number;
}) {
  return (
    <div style={autoWrapStyle}>
      <AutoToggle auto={auto} onToggleAuto={onToggleAuto} />
      <LiveReadout
        auto={auto}
        tps={tps}
        onViewNext={onViewNext}
        game={game}
        movesThisGame={movesThisGame}
        movesPerGame={movesPerGame}
      />
    </div>
  );
}

/**
 * The single Auto "take the wheel" toggle — its own pill so the narrow layout can pin it
 * top-right while the {@link LiveReadout} reflows to its own row. ON = watch two bots
 * co-paint one tunnel; OFF = you author seat A vs the seat-B bot on the SAME tunnel.
 */
export function AutoToggle({
  auto,
  onToggleAuto,
}: {
  auto: boolean;
  onToggleAuto: () => void;
}) {
  return (
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
      className="sketch-stroke sketch-panel"
      style={autoToggleStyle}
    >
      <span style={autoToggleLabelStyle}>
        <BrushIcon size={14} />
        {auto ? "Auto" : "Draw"}
      </span>
      <span
        style={{
          ...switchTrackStyle,
          background: auto ? WC.accent : WC.track,
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
  );
}

/** The live "who vs who · TPS · View" readout. A separate piece so the narrow layout can
 *  drop it onto its own row below the toolbar — never stacked over the color controls. */
export function LiveReadout({
  auto,
  tps,
  onViewNext,
  game,
  movesThisGame,
  movesPerGame,
  centered = false,
  compact = false,
}: {
  auto?: boolean;
  tps: number;
  onViewNext: () => void;
  /** Current bounded-game number (the wall runs as discrete MOVES_PER_GAME games). */
  game: number;
  /** Co-signed moves on the current tunnel since the last game boundary. */
  movesThisGame: number;
  /** Per-game co-signed-move cap (the bound at which the canvas wipes for a new game). */
  movesPerGame: number;
  /** Center the contents (narrow stacked layout) instead of right-aligning them. */
  centered?: boolean;
  /** Drop the Game/progress detail (keep TPS + View) so the row fits at narrow widths. */
  compact?: boolean;
}) {
  return (
    <div
      className="sketch-stroke sketch-panel"
      style={
        centered ? { ...readoutStyle, justifyContent: "center" } : readoutStyle
      }
    >
      <LiveDot />
      <span style={{ color: WC.text }}>{Math.round(tps)} TPS</span>
      {/* Bounded-game progress: which game + how far into its MOVES_PER_GAME cap (the canvas
          wipes at the cap and a new game starts) — like Blackjack "Round X" / Battleship "Game N".
          Dropped at narrow widths (`compact`) so the row stays one tidy line. */}
      {!compact && (
        <>
          <span style={{ color: WC.muted }}>·</span>
          <span style={{ color: WC.text }}>
            Game {game} · {movesThisGame.toLocaleString("en-US")} /{" "}
            {movesPerGame.toLocaleString("en-US")}
          </span>
        </>
      )}
      <span style={readoutDividerStyle} />
      <button
        type="button"
        onClick={onViewNext}
        title="Jump the camera to the next bot"
        className="sketch-btn sketch-btn--ghost"
      >
        View
      </button>
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
  tps,
  onViewNext,
}: {
  /** Per-painter tallies, keyed by address (stable identity, mutated in place). */
  painters: ReadonlyMap<string, PainterInfo>;
  /** Live co-signed throughput (the TPS dial) — shown in the header. */
  tps: number;
  /** Cycle the camera to the next live painter (engine.viewNextAgent). */
  onViewNext: () => void;
}) {
  const top = useTopPainters(painters, 5);
  return (
    <div className="sketch-stroke sketch-panel" style={mostPaintedStyle}>
      <div
        className="sketch-eyebrow"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 3,
        }}
      >
        <BrushIcon size={12} />
        Most painted
        {/* The live readout rides here (not the top bar) so the canvas stays clear:
            • TPS · View. */}
        <span style={{ flex: 1 }} />
        <LiveDot />
        <span style={{ color: WC.text }}>{Math.round(tps)} TPS</span>
        <button
          type="button"
          onClick={onViewNext}
          title="Jump the camera to the next painter"
          className="sketch-btn sketch-btn--ghost"
          style={{ height: 22, padding: "0 8px", fontSize: 11 }}
        >
          View
        </button>
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
        borderRadius: 0,
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
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`sketch-btn ${active ? "sketch-btn--go" : "sketch-btn--ghost"}`}
      style={{
        width: 34,
        height: 34,
        padding: 0,
        display: "grid",
        placeItems: "center",
        color: active ? "var(--sketch-accent)" : "var(--sketch-ink)",
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
        background: WC.glassBorder,
        flex: "0 0 auto",
      }}
    />
  );
}

/** The faded-frost floating toolbar island (theme-aware glass over the white wall). It
 *  never exceeds the canvas width — groups wrap to extra rows before anything is clipped. */
const islandStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  justifyContent: "center",
  gap: 6,
  rowGap: 6,
  maxWidth: "calc(100% - 16px)",
  padding: 8,
};

/** Stacked override: drop the absolute float so the parent's top bar lays the island out
 *  in normal flow (its own row, no overlap with the back button / arena cluster). */
const islandStackedStyle: CSSProperties = {
  position: "relative",
  top: "auto",
  left: "auto",
  transform: "none",
  zIndex: "auto",
  maxWidth: "100%",
  pointerEvents: "auto",
};

/** A toolbar group (tools / swatches / sizes) — wraps gracefully when the island runs
 *  out of width so swatches reflow instead of being cut off. */
const swatchGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  justifyContent: "center",
  gap: 5,
};

const toolGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  flexShrink: 0,
};

const brushGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 3,
  flexShrink: 0,
};

/** Top-right arena cluster: the Auto "take the wheel" toggle above its live readout.
 *  Capped to the canvas width so it never runs off the left edge at narrow sizes. */
const autoWrapStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  zIndex: 60,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 8,
  maxWidth: "calc(100% - 28px)",
};

/** The collapsed current-color/background swatch shown in the narrow toolbar — tapping it
 *  opens the matching {@link popoverStyle} grid. Slightly larger than a palette chip so it
 *  reads as the active selection + an affordance to open the rest. */
function currentSwatchStyle(
  fill: string,
  active: boolean,
  radius: number | string = 0,
): CSSProperties {
  return {
    width: 26,
    height: 26,
    borderRadius: radius,
    cursor: "pointer",
    padding: 0,
    background: fill,
    border: `1px solid ${WC.hairline}`,
    boxShadow: active
      ? `0 0 0 2px ${WC.accent}`
      : "inset 0 0 0 1.5px rgba(255,255,255,0.32)",
  };
}

/** Full-viewport transparent catcher behind an open popover — an outside click closes it. */
const popoverBackdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 79,
};

/** The narrow-width swatch popover: a small frosted grid of the colors/backgrounds,
 *  anchored just under its trigger swatch. */
const popoverStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 8px)",
  left: 0,
  zIndex: 80,
  display: "grid",
  gridTemplateColumns: "repeat(3, auto)",
  gap: 6,
  padding: 8,
};

/** The single Auto toggle pill (faded glass): a label + a sliding switch — "take the
 *  wheel". ON = watch two bots co-paint; OFF = you author seat A vs the seat-B bot. */
const autoToggleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  height: 40,
  maxWidth: "100%",
  padding: "0 14px",
  cursor: "pointer",
  border: "none",
  background: "transparent",
  // Always catch clicks even when a click-through (pointer-events:none) bar wraps it —
  // otherwise the toggle inherits `none` and you can't flip Auto off to draw.
  pointerEvents: "auto",
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
  boxShadow: "0 1px 2px rgba(12,15,29,0.28)",
  transition: "transform .14s",
};

const readoutStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  flexWrap: "wrap",
  gap: 7,
  rowGap: 4,
  minHeight: 36,
  maxWidth: "100%",
  padding: "5px 14px",
  fontSize: 12.5,
  fontWeight: 700,
  color: WC.text,
};

const readoutDividerStyle: CSSProperties = {
  width: 1,
  height: 16,
  background: WC.glassBorder,
  margin: "0 2px",
  flex: "0 0 auto",
};

/** Bottom-right "most painted" leaderboard card — positioning only; the ink-stroke
 *  frame + Gochi Hand text come from the `.sketch-stroke .sketch-panel` skin. */
const mostPaintedStyle: CSSProperties = {
  position: "absolute",
  right: 14,
  bottom: 18,
  zIndex: 60,
  minWidth: 176,
  maxWidth: "min(224px, calc(100% - 28px))",
  display: "flex",
  flexDirection: "column",
  gap: 3,
  padding: "11px 13px",
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
