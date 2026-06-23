import { useState, type CSSProperties, type ReactNode } from "react";
import { PALETTE, WC, FONT_DISPLAY, FONT_MONO } from "./tokens";

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
 * stepper — that's the whole config surface. No menus, no panels. The AUTO control
 * is its own pill in the top-right ({@link AutoControl}).
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
 * The AUTO control — the arena's "Self-play (bots)" button for this game. Spawning
 * calls the engine's {@link spawnAgent}; each agent paints alongside the human on
 * its own tunnel. A live readout shows how many bots are co-painting and the
 * current co-signed throughput (TPS).
 */
export function AutoControl({
  agentCount,
  tps,
  onSpawn,
  onStop,
}: {
  agentCount: number;
  tps: number;
  /** Spawn ONE more agent (engine.spawnAgent). */
  onSpawn: () => void;
  /** Stop every agent (engine.stopAgents). */
  onStop: () => void;
}) {
  if (agentCount === 0) {
    return (
      <div style={autoWrapStyle}>
        <button type="button" onClick={onSpawn} style={primaryButtonStyle}>
          <BotIcon />
          Self-play (bots)
        </button>
      </div>
    );
  }
  return (
    <div style={autoWrapStyle}>
      <div style={readoutStyle}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: WC.accent,
              boxShadow: `0 0 8px ${WC.accent}`,
            }}
          />
          {agentCount} {agentCount === 1 ? "bot" : "bots"}
        </span>
        <span style={{ color: "#9aa3bb" }}>·</span>
        <span style={{ color: WC.text }}>{Math.round(tps)} TPS</span>
      </div>
      <button type="button" onClick={onSpawn} title="Add a bot" style={addButtonStyle}>
        +
      </button>
      <button type="button" onClick={onStop} style={stopButtonStyle}>
        Stop
      </button>
    </div>
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

const autoWrapStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontFamily: FONT_DISPLAY,
};

const primaryButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 36,
  padding: "0 16px",
  borderRadius: 10,
  border: "none",
  cursor: "pointer",
  fontSize: 13.5,
  fontWeight: 700,
  color: "#06203B",
  background: WC.accent,
  boxShadow: "0 6px 18px rgba(77,162,255,0.4)",
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

const addButtonStyle: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.14)",
  cursor: "pointer",
  fontSize: 18,
  fontWeight: 700,
  lineHeight: 1,
  color: WC.text,
  background: "rgba(10,16,34,0.72)",
  backdropFilter: "blur(8px)",
};

const stopButtonStyle: CSSProperties = {
  height: 36,
  padding: "0 14px",
  borderRadius: 10,
  border: "none",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 700,
  color: "#fff",
  background: "#e0556a",
};

/* --- inline icons (lucide-style, 18px, stroke = currentColor) --- */

function iconProps() {
  return {
    width: 18,
    height: 18,
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

function BotIcon() {
  return (
    <svg {...iconProps()} stroke="#06203B">
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <path d="M12 7v4" />
      <circle cx="12" cy="5" r="2" />
      <path d="M8 16h.01M16 16h.01" />
    </svg>
  );
}
