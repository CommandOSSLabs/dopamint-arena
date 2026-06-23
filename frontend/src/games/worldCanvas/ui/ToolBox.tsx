/**
 * The Paint app's left TOOL BOX — a beveled 2-column grid of tools plus a
 * tool-options strip (brush size). Three tools are wired to the canvas's only real
 * paint op: Brush (paint with the primary color), Pencil (paint, forced 1×), and
 * Eraser (paint with the secondary/background color). The rest (Fill, Color-picker,
 * Line, Rectangle, Ellipse) are present and selectable but not yet wired — they show
 * a "coming soon" hint and the canvas keeps brushing. Render-only chrome.
 */
import {
  W98,
  FONT_W98,
  FONT_MONO,
  w98Outset,
  w98Button,
} from "./tokens";

export type ToolId =
  | "pencil"
  | "brush"
  | "fill"
  | "eraser"
  | "pick"
  | "line"
  | "rect"
  | "ellipse";

export interface ToolSpec {
  id: ToolId;
  glyph: string;
  label: string;
  /** True if the tool changes the canvas's actual paint op (vs. present-but-soon). */
  wired: boolean;
}

/** Tool catalog in palette order (two columns, top-to-bottom by row). */
export const TOOLS: ToolSpec[] = [
  { id: "pencil", glyph: "✏️", label: "Pencil", wired: true },
  { id: "brush", glyph: "🖌️", label: "Brush", wired: true },
  { id: "fill", glyph: "🪣", label: "Fill With Color", wired: false },
  { id: "eraser", glyph: "🧽", label: "Eraser / Background", wired: true },
  { id: "pick", glyph: "💧", label: "Pick Color", wired: false },
  { id: "line", glyph: "╲", label: "Line", wired: false },
  { id: "rect", glyph: "▭", label: "Rectangle", wired: false },
  { id: "ellipse", glyph: "◯", label: "Ellipse", wired: false },
];

const TOOLS_BY_ID: Record<ToolId, ToolSpec> = Object.fromEntries(
  TOOLS.map((t) => [t.id, t]),
) as Record<ToolId, ToolSpec>;

const SIZES = [1, 2, 3] as const;

export function ToolBox({
  tool,
  onTool,
  brushSize,
  onBrushSize,
}: {
  tool: ToolId;
  onTool: (t: ToolId) => void;
  brushSize: number;
  onBrushSize: (n: number) => void;
}) {
  const active = TOOLS_BY_ID[tool];
  // Pencil is always 1px; Fill / Pick have no footprint — lock the size strip there.
  const sizeLocked = tool === "pencil" || tool === "fill" || tool === "pick";

  return (
    <div
      style={{
        flex: "0 0 auto",
        width: 62,
        ...w98Outset,
        padding: 3,
        display: "flex",
        flexDirection: "column",
        gap: 5,
        fontFamily: FONT_W98,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 1,
        }}
      >
        {TOOLS.map((t) => {
          const on = t.id === tool;
          return (
            <button
              key={t.id}
              onClick={() => onTool(t.id)}
              title={t.wired ? t.label : `${t.label} — coming soon`}
              aria-pressed={on}
              style={{
                ...w98Button(on),
                height: 26,
                display: "grid",
                placeItems: "center",
                fontSize: 14,
                lineHeight: 1,
                cursor: "pointer",
                opacity: t.wired ? 1 : 0.72,
                color: W98.text,
                padding: 0,
              }}
            >
              <span style={{ transform: on ? "translate(1px,1px)" : "none" }}>
                {t.glyph}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tool-options strip: brush footprint size (the classic size chooser). */}
      <div
        style={{
          ...w98Outset,
          padding: "4px 3px 5px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 3,
        }}
      >
        <span style={{ fontSize: 9, color: W98.textDim, letterSpacing: "0.04em" }}>
          {active.wired ? "Size" : "soon"}
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, width: "100%" }}>
          {SIZES.map((n) => {
            const on = n === brushSize && !sizeLocked;
            return (
              <button
                key={n}
                onClick={() => !sizeLocked && onBrushSize(n)}
                disabled={sizeLocked}
                title={`Brush ${n}×${n}`}
                style={{
                  ...w98Button(on),
                  height: 16,
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  fontWeight: 700,
                  color: sizeLocked ? W98.disabled : W98.text,
                  cursor: sizeLocked ? "default" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                  padding: 0,
                }}
              >
                <span
                  style={{
                    width: n * 3 + 1,
                    height: n * 3 + 1,
                    borderRadius: "50%",
                    background: sizeLocked ? W98.disabled : W98.text,
                    display: "inline-block",
                  }}
                />
                {n}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
