import { PALETTE, WC, FONT_MONO } from "./tokens";

/**
 * Bottom-center color dock — 16 swatches mapping 1:1 to the protocol's palette
 * index `[0, 16)`. The selected swatch is the color the next click paints.
 */
export function PaletteDock({
  selected,
  onSelect,
}: {
  selected: number;
  onSelect: (color: number) => void;
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
