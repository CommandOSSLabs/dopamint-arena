/**
 * The Paint app's bottom COLOR BOX (jspaint style): a foreground/background dual-
 * color indicator on the left, then the 16-color palette in two rows of eight.
 * Left-click a swatch sets the PRIMARY (foreground) color; right-click sets the
 * SECONDARY (background) color — the classic MS-Paint convention. Both indices map
 * 1:1 to the protocol palette `[0,16)`; the secondary is what the Eraser tool paints.
 */
import { PALETTE, W98, FONT_W98, w98Outset, w98Inset } from "./tokens";

/** Two rows of eight, mirroring the classic Paint palette grid layout. */
const ROW_LEN = 8;

export function PaletteDock({
  primary,
  secondary,
  onPrimary,
  onSecondary,
}: {
  primary: number;
  secondary: number;
  onPrimary: (color: number) => void;
  onSecondary: (color: number) => void;
}) {
  const rows = [
    PALETTE.slice(0, ROW_LEN),
    PALETTE.slice(ROW_LEN, ROW_LEN * 2),
  ];
  return (
    <div
      style={{
        flex: "0 0 auto",
        ...w98Outset,
        padding: "4px 6px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontFamily: FONT_W98,
      }}
    >
      {/* Foreground/background dual-color indicator. */}
      <div
        style={{
          ...w98Inset,
          width: 38,
          height: 38,
          position: "relative",
          flex: "0 0 auto",
        }}
        title={`Foreground: color ${primary} · Background: color ${secondary}`}
      >
        <span
          style={{
            position: "absolute",
            left: 16,
            top: 16,
            width: 17,
            height: 17,
            background: PALETTE[secondary] ?? "#000",
            boxShadow: `inset 1px 1px 0 ${W98.shadow}, 0 0 0 1px ${W98.darkShadow}`,
          }}
        />
        <span
          style={{
            position: "absolute",
            left: 5,
            top: 5,
            width: 17,
            height: 17,
            background: PALETTE[primary] ?? "#fff",
            boxShadow: `inset 1px 1px 0 ${W98.hilight}, 0 0 0 1px ${W98.darkShadow}`,
          }}
        />
      </div>

      <span style={{ width: 1, height: 34, background: W98.shadow, flex: "0 0 auto" }} />

      {/* The 16-color palette: two rows of eight. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {rows.map((row, r) => (
          <div key={r} style={{ display: "flex", gap: 2 }}>
            {row.map((hex, c) => {
              const i = r * ROW_LEN + c;
              const isPrimary = i === primary;
              const isSecondary = i === secondary;
              return (
                <button
                  key={i}
                  onClick={() => onPrimary(i)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onSecondary(i);
                  }}
                  title={`Color ${i} — left-click foreground, right-click background`}
                  style={{
                    width: 16,
                    height: 16,
                    background: hex,
                    cursor: "pointer",
                    padding: 0,
                    boxShadow: isPrimary
                      ? `0 0 0 1px ${W98.field}, 0 0 0 2px ${W98.darkShadow}`
                      : `inset 1px 1px 0 rgba(255,255,255,0.5), 0 0 0 1px ${W98.shadow}`,
                    outline: isSecondary ? `2px dotted ${W98.darkShadow}` : "none",
                    outlineOffset: -3,
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
