import type { ReactNode } from "react";

const COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
const ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// A fixed label row (not `auto`) so the cell grid and the ship-overlay grid
// resolve identical track sizes and line up exactly.
const TEMPLATE = {
  gridTemplateColumns: "0.9rem repeat(10, minmax(0, 1fr))",
  gridTemplateRows: "1rem repeat(10, minmax(0, 1fr))",
} as const;

/**
 * The classic 10×10 Battleship frame: column letters A–J across the top, row
 * numbers 1–10 down the side. `renderCell` draws each of the 100 squares by its
 * row-major index. `children` (ship sprites) render in a second grid layered over
 * the cells with the SAME track template, so a ship placed by grid lines spans its
 * full footprint without disturbing the cells' auto-flow. The overlay sits BEHIND
 * the cells (z-0 vs z-10) so hit/miss markers stay on top.
 */
export function GridFrame({
  renderCell,
  children,
}: {
  renderCell: (cell: number) => ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="relative w-full">
      <div className="relative z-10 grid w-full gap-[2px]" style={TEMPLATE}>
        <span />
        {COLS.map((c) => (
          <span
            key={`c${c}`}
            className="text-center text-[9px] leading-4 text-arena-muted"
          >
            {c}
          </span>
        ))}
        {ROWS.map((r, ri) => (
          <FrameRow key={`r${r}`} label={r}>
            {COLS.map((_, ci) => renderCell(ri * 10 + ci))}
          </FrameRow>
        ))}
      </div>
      {children && (
        <div
          className="pointer-events-none absolute inset-0 z-0 grid w-full gap-[2px]"
          style={TEMPLATE}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function FrameRow({ label, children }: { label: number; children: ReactNode }) {
  return (
    <>
      <span className="flex items-center justify-center text-[9px] text-arena-muted">
        {label}
      </span>
      {children}
    </>
  );
}
