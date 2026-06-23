import { PALETTE, WC, FONT_MONO } from "./tokens";

/** Brush footprint sizes (cells per edge) offered in the dock; default is 1. */
const BRUSH_SIZES = [1, 2, 3] as const;

/**
 * Bottom-center paint dock — a brush-size selector plus 16 color swatches mapping
 * 1:1 to the protocol's palette index `[0, 16)`. The selected swatch is the color
 * the next stroke paints; the brush size is the N×N footprint stamped per cell.
 */
export function PaletteDock({
  selected,
  onSelect,
  brushSize,
  onBrushSizeChange,
}: {
  selected: number;
  onSelect: (color: number) => void;
  brushSize: number;
  onBrushSizeChange: (size: number) => void;
}) {
  return (
    <div
      className="absolute bottom-[16px] left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-[14px] px-3 py-2"
      style={{
        background: "rgba(10,16,34,0.7)",
        border: "1px solid rgba(255,255,255,0.12)",
        backdropFilter: "blur(10px)",
      }}
    >
      <span
        className="mr-1 hidden text-[10px] uppercase tracking-[0.18em] sm:block"
        style={{ color: WC.muted, fontFamily: FONT_MONO }}
      >
        Brush
      </span>
      <div className="flex items-center gap-[4px]">
        {BRUSH_SIZES.map((n) => {
          const active = n === brushSize;
          return (
            <button
              key={n}
              onClick={() => onBrushSizeChange(n)}
              aria-pressed={active}
              title={`Brush ${n}×${n}`}
              className="flex h-[24px] w-[24px] items-center justify-center rounded-[7px] text-[12px] font-bold tabular-nums"
              style={{
                color: active ? "#06203B" : WC.text,
                background: active ? WC.accent : "rgba(255,255,255,0.06)",
                border: active
                  ? `1px solid ${WC.accent}`
                  : "1px solid rgba(255,255,255,0.12)",
                cursor: "pointer",
                fontFamily: FONT_MONO,
                transition: "background .12s, color .12s",
              }}
            >
              {n}
            </button>
          );
        })}
      </div>

      <span
        className="ml-1 h-[22px] w-px"
        style={{ background: "rgba(255,255,255,0.12)" }}
      />

      <span
        className="ml-1 mr-1 hidden text-[10px] uppercase tracking-[0.18em] sm:block"
        style={{ color: WC.muted, fontFamily: FONT_MONO }}
      >
        Color
      </span>
      <div className="flex flex-wrap items-center gap-[5px]" style={{ maxWidth: 360 }}>
        {PALETTE.map((hex, i) => {
          const active = i === selected;
          return (
            <button
              key={i}
              onClick={() => onSelect(i)}
              aria-pressed={active}
              title={`Color ${i}`}
              className="h-[22px] w-[22px] rounded-[6px]"
              style={{
                background: hex,
                cursor: "pointer",
                border: active
                  ? `2px solid ${WC.text}`
                  : "1px solid rgba(0,0,0,0.35)",
                boxShadow: active ? `0 0 0 2px ${WC.accent}` : "none",
                transform: active ? "translateY(-2px)" : "none",
                transition: "transform .12s",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
